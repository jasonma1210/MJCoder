// C2 回归门禁：进程级崩溃必须留痕，且自动重载不能变成死循环。
//
// 缺口背景（2026-10-17 现场核查）：全仓没有 render-process-gone / child-process-gone /
// unresponsive 监听。JS 层异常还有 window.onerror → diag:report，但渲染进程整体崩掉时
// 渲染层自己报不了，主进程也没人听 → 白屏 + 零证据（Crashpad 也没有 dmp）。
//
// 本门禁锁四件事：
//   ① 非 clean-exit 的渲染进程退出必须被记录（kind + reason + exitCode）；
//   ② 自动 reload 有滑动窗口上限——超了就只记录不重载（否则必崩 bug = 无限重载刷爆日志）；
//   ③ unresponsive **不重载**（重载等于把用户正在跑的任务杀掉），只记录；
//   ④ 通知「取完即清」，避免每次启动重复弹。
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const { createCrashGuard, DEFAULT_MAX_RELOADS } = require(path.join(ROOT, 'main/lifecycle/crashGuard.js'));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.log(`[FAIL] ${name}\n       ${e.message}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

function harness(opts = {}) {
  const reported = [];
  const reloads = [];
  let clock = 1000000;
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    reload: () => reloads.push(Date.now()),
  });
  const app = new EventEmitter();
  const guard = createCrashGuard({
    reportError: (kind, err, extra) => reported.push({ kind, message: String(err?.message || err), extra }),
    getMainWindow: () => (opts.noWindow ? null : win),
    now: () => clock,
    ...opts,
  });
  guard.attach(app);
  guard.attachWindow(win);
  return { guard, app, win, reported, reloads, advance: (ms) => { clock += ms; }, clockOf: () => clock };
}

check('clean-exit 不算事故：不记录、不重载', () => {
  const { guard, reported, reloads } = harness();
  const r = guard.onRenderProcessGone({}, {}, { reason: 'clean-exit', exitCode: 0 });
  assert(r.action === 'none', `action 应为 none，实际 ${r.action}`);
  assert(reported.length === 0, `不应记录，实际 ${reported.length} 条`);
  assert(reloads.length === 0, '不应重载');
});

check('崩溃必须留痕（kind + reason + exitCode）并自动重载', () => {
  const { guard, reported, reloads } = harness();
  const r = guard.onRenderProcessGone({}, {}, { reason: 'crashed', exitCode: 133 });
  assert(r.action === 'reload', `action 应为 reload，实际 ${r.action}`);
  assert(reported.length === 1, `应记录 1 条，实际 ${reported.length}`);
  assert(reported[0].kind === 'render-process-gone', `kind 不对：${reported[0].kind}`);
  assert(/crashed/.test(reported[0].message), '记录里缺 reason');
  assert(reported[0].extra?.exitCode === 133, '记录里缺 exitCode');
  assert(reloads.length === 1, `应重载 1 次，实际 ${reloads.length}`);
});

check('窗口内连续崩溃达到上限后停止自动重载（防重载死循环）——反向用例', () => {
  const { guard, reported, reloads } = harness();
  for (let i = 0; i < DEFAULT_MAX_RELOADS; i += 1) guard.onRenderProcessGone({}, {}, { reason: 'crashed' });
  assert(reloads.length === DEFAULT_MAX_RELOADS, `前 ${DEFAULT_MAX_RELOADS} 次应重载，实际 ${reloads.length}`);
  const last = guard.onRenderProcessGone({}, {}, { reason: 'crashed' });
  assert(last.action === 'skip' && last.throttled === true, `超限后应 skip，实际 ${JSON.stringify(last)}`);
  assert(reloads.length === DEFAULT_MAX_RELOADS, `超限后不得再重载，实际 ${reloads.length}`);
  assert(reported.some((r) => r.kind === 'render-process-gone-loop'), '缺少 loop 记录，事后无从判断是不是死循环');
});

check('时间窗滑过后恢复自动重载', () => {
  const { guard, reloads, advance } = harness({ reloadWindowMs: 60000, maxReloads: 1 });
  guard.onRenderProcessGone({}, {}, { reason: 'crashed' });
  assert(reloads.length === 1, '首次应重载');
  assert(guard.onRenderProcessGone({}, {}, { reason: 'crashed' }).action === 'skip', '窗口内第二次应 skip');
  advance(61000);
  assert(guard.onRenderProcessGone({}, {}, { reason: 'crashed' }).action === 'reload', '窗口过后应恢复重载');
  assert(reloads.length === 2, `应共重载 2 次，实际 ${reloads.length}`);
});

check('没有窗口时不崩（reload 目标可能已销毁）', () => {
  const { guard, reported } = harness({ noWindow: true });
  const r = guard.onRenderProcessGone({}, {}, { reason: 'crashed' });
  assert(r.action === 'no-window', `应为 no-window，实际 ${r.action}`);
  assert(reported.length >= 1, '仍必须留痕');
});

check('child-process-gone：clean-exit 不记，异常记录（GPU/utility 崩了要有据可查）', () => {
  const { guard, reported } = harness();
  guard.onChildProcessGone({}, { type: 'GPU', reason: 'clean-exit' });
  assert(reported.length === 0, 'clean-exit 不应记录');
  const r = guard.onChildProcessGone({}, { type: 'Utility', reason: 'crashed', exitCode: 1, serviceName: 'network.mojom.NetworkService' });
  assert(r.action === 'record', `应为 record，实际 ${r.action}`);
  assert(reported[0].kind === 'child-process-gone', 'kind 不对');
  assert(/Utility/.test(reported[0].message), '记录里缺子进程类型');
});

check('unresponsive 只记录、绝不自动重载（重载会杀掉正在跑的任务）', () => {
  const { guard, reported, reloads } = harness();
  const r = guard.onUnresponsive();
  assert(r.action === 'record', `应为 record，实际 ${r.action}`);
  assert(reported[0]?.kind === 'renderer-unresponsive', '未记录 unresponsive');
  assert(reloads.length === 0, 'unresponsive 不得触发 reload');
});

check('responsive 记录卡顿时长', () => {
  const { guard, advance } = harness();
  guard.onUnresponsive();
  advance(4200);
  const r = guard.onResponsive();
  assert(r.durationMs === 4200, `durationMs 应为 4200，实际 ${r.durationMs}`);
});

check('通知取完即清（避免每次启动重复弹）', () => {
  const { guard } = harness();
  guard.onRenderProcessGone({}, {}, { reason: 'crashed' });
  const first = guard.takeNotices();
  assert(first.length === 1, `首次应 1 条，实际 ${first.length}`);
  const second = guard.takeNotices();
  assert(second.length === 0, `二次应为空，实际 ${second.length}`);
});

check('事件真的挂到了 app / window 上（attach 不是空转）', () => {
  const { app, win, reported, reloads } = harness();
  assert(app.listenerCount('render-process-gone') === 1, 'app 上未挂 render-process-gone');
  assert(app.listenerCount('child-process-gone') === 1, 'app 上未挂 child-process-gone');
  assert(win.listenerCount('unresponsive') === 1, '窗口上未挂 unresponsive');
  app.emit('render-process-gone', {}, {}, { reason: 'crashed' });
  win.emit('unresponsive');
  assert(reported.length === 2, `经事件触发应记录 2 条，实际 ${reported.length}`);
  assert(reloads.length === 1, '经事件触发应重载 1 次');
});

console.log(`\n结果：${pass}/${total} 通过`);
if (pass !== total) process.exitCode = 1;

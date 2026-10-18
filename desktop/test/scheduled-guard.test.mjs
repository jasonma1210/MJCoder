#!/usr/bin/env node
// 定时通道「对外动作闸门」回归（产物形态即校验）
//
// 守的是一条产品红线：**无人值守不执行对外/不可逆动作**，而是攒成「待确认动作清单」。
// 为什么必须有：事后判分能拦住「宣告成功」，拦不住**已经推出去的 commit / 已经发出去的消息**。
//
// 判据：把 BLOCKED 表里的任一项删掉、或让 blocked 仍调用下游实现、或允许 writeFile 被拦
// （那会连任务产物都写不出来）—— 本套件必须变红。
import { createScheduledGuard, blockedReason } from '../main/scheduledGuard.js';
import { renderRunSection } from '../main/scheduledOutput.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const okHandler = (tag) => async () => ({ ok: true, tag });

// ── ① 拦什么 ──
check('gitCommit 被拦', blockedReason('gitCommit', {}).length > 0);
check('gitAdd 被拦', blockedReason('gitAdd', {}).length > 0);
check('MCP 调用被拦（外部副作用无法从工具名区分读/写）', blockedReason('mcpCallTool', {}).length > 0);
check('PR 评审/评论被拦', blockedReason('prReview', {}).length > 0 && blockedReason('prComment', {}).length > 0);
check('shell 里的 git push 被拦', blockedReason('shell', { command: 'git push origin main' }).length > 0);

// ── ② 放什么（放错等于任务干不了活）──
check('本地写文件放行（这是任务产物本身）', blockedReason('writeFile', { path: 'a.md' }) === '');
check('应用补丁放行', blockedReason('applyPatch', { patch: 'x' }) === '');
check('读/grep/glob 放行', blockedReason('readFile', {}) === '' && blockedReason('grep', {}) === '');
check('普通 shell 放行（npm test / 构建）', blockedReason('shell', { command: 'npm test' }) === '');
check('git 只读命令放行（status/log/diff）',
  blockedReason('gitStatus', {}) === '' && blockedReason('gitLog', {}) === '');
check('PR 只读（list/view/diff）放行',
  blockedReason('prList', {}) === '' && blockedReason('prView', {}) === '');

// ── ③ 拦截行为：不调用下游 + 结构化失败 ──
{
  const g = createScheduledGuard();
  let called = 0;
  const wrapped = g.wrap({
    gitCommit: async () => { called += 1; return { ok: true }; },
    writeFile: okHandler('write'),
  });
  const res = await wrapped.gitCommit({ message: 'x' });
  check('被拦时下游实现一次都不执行（动作真的没发生）', called === 0, `called=${called}`);
  check('被拦返回结构化失败（ok:false + blocked + SCHEDULED_BLOCKED）',
    res.ok === false && res.blocked === true && /SCHEDULED_BLOCKED/.test(res.error));
  check('提示模型不要重试（否则会把预算烧在同一个动作上）', /勿重试/.test(res.error));
  const w = await wrapped.writeFile({ path: 'a.md' });
  check('放行的工具照常执行', w.ok === true && w.tag === 'write');
}

// ── ④ 待确认清单：去重 + take 清空 ──
{
  const g = createScheduledGuard();
  const wrapped = g.wrap({ gitCommit: async () => ({ ok: true }) });
  await wrapped.gitCommit({ message: 'same' });
  await wrapped.gitCommit({ message: 'same' });
  await wrapped.gitCommit({ message: 'other' });
  const list = g.take();
  check('同一动作被重试多次只记一条（模型常重试 2–3 次）', list.length === 2, `len=${list.length}`);
  check('清单条目带工具名，便于人工照着做', list[0].tool === 'git_commit', JSON.stringify(list[0]));
  check('清单条目带可照抄的命令（commit 连 message 一起记）',
    list[0].command === 'git commit -m "other"' || list[0].command === 'git commit -m "same"',
    JSON.stringify(list.map((x) => x.command)));
  check('take() 之后清单清空（不会跨任务串味）', g.take().length === 0);
}

// ── ⑤ 任务级放行开关 ──
{
  const g = createScheduledGuard({ enabled: false });
  let called = 0;
  const wrapped = g.wrap({ gitCommit: async () => { called += 1; return { ok: true }; } });
  const res = await wrapped.gitCommit({ message: 'x' });
  check('external_policy=allow 时不拦截（任务显式放开）', called === 1 && res.ok === true);
  check('放行模式下不产生待确认项', g.take().length === 0);
}
{
  const g = createScheduledGuard();
  const noFn = g.wrap({ someValue: 42 });
  check('非函数成员原样保留（不把工具表结构改坏）', noFn.someValue === 42);
}

// ── ⑥ 产物：清单必须进归档 md（应用外唯一可查阅的出口）──
{
  const md = renderRunSection({
    status: 'success', output: '报告正文', trigger: 'scheduled', duration_ms: 1000, tools: 3,
    pending_actions: [{ tool: 'git_commit', command: 'git commit -m "x"' }],
  });
  check('归档 md 含「待确认动作」小节', md.includes('待确认动作（1 项'));
  check('归档 md 含具体命令（照着能手工执行）', md.includes('git commit -m'));
  const clean = renderRunSection({ status: 'success', output: 'x', duration_ms: 1 });
  check('无待确认项时不出现该小节（不留空壳噪音）', !clean.includes('待确认动作'));
}

console.log(`\nscheduled-guard: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;

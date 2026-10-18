// D1 真实链路的门禁：**必须过 agent-core 循环**，直调 handler 测不出这个 bug。
//
// 事故（tester 实测，cwd=产物目录 + contextCwd=项目 + 契约已下发）：
//   git_status → fatal: not a git repository；read_file('README.md') → notFound。
// 根因：agent-core 对 CWD_TOOLS **无条件**把宿主 cwd（= 产出目录）写进 toolArgs.cwd，
// 所以 `args.cwd || contextCwd` 里的 args.cwd 永远非空 —— contextCwd 成了死代码。
// 单元级 `h.gitStatus({})` 却全绿，正是「测试把 bug 编码成规范」的典型：它绕过了注入。
//
// 本文件用真实 runAgent + 真实 exec.js 工具 + 真实 git 仓库跑一遍工具循环，断言：
//   ① git_status 在**项目**里执行（不是 fatal: not a git repository）
//   ② read_file 的相对路径读到**项目**里的文件（不是产物目录）
//   ③ 写工具的相对路径仍落**产物目录**（不是项目目录）—— 这是 cwd 反转不许放开的边界
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { runAgent } = await import('../agent-core/index.js');

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); fail++; }
}

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-ctxcwd-ud-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-ctxcwd-work-'));
const REPO = path.join(WORK, 'project');
const OUT_DIR = path.join(WORK, 'output-dir'); // 模拟产出目录（runAgent 的 cwd）
const noop = () => {};
fs.mkdirSync(REPO, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// 真实 git 仓库：提交 README.md，再留一个未跟踪文件（让 git_status 有可断言的输出）
const README = '# 项目说明\n这是一个用于验证 contextCwd 的真实 git 仓库。\n';
fs.writeFileSync(path.join(REPO, 'README.md'), README);
execFileSync('git', ['init'], { cwd: REPO });
execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: REPO });
execFileSync('git', ['config', 'user.name', 'test'], { cwd: REPO });
execFileSync('git', ['add', '.'], { cwd: REPO });
execFileSync('git', ['commit', '-m', 'init'], { cwd: REPO });
fs.writeFileSync(path.join(REPO, 'untracked-marker.txt'), 'x\n');

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
const { unattendedApproval } = require(path.join(ROOT, 'main', 'scheduledGuard.js'));

toolExec.initToolExec({
  requestApproval: unattendedApproval(() => new Promise((resolve) => setTimeout(() => resolve('deny'), 3000))),
  applyApprovalDecision: noop,
  getAlwaysRules: () => [],
  conversationRules: [],
  getDefaultCwd: () => OUT_DIR,
  registerChild: noop,
});

const model = {
  provider: { id: 1, isGlobal: false, base_url: 'https://api.test/v1' },
  model: { id: 1, model_id: 'test-model', context_window: 128000 },
};

const WRITE_NAME = 'notes-2026-10-18.md';
const SCRIPT = [
  { content: '先看 git 状态', tool_calls: [{ id: 'c1', function: { name: 'git_status', arguments: '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  { content: '再读项目说明', tool_calls: [{ id: 'c2', function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } }], usage: { prompt_tokens: 12, completion_tokens: 5 } },
  { content: '写产物', tool_calls: [{ id: 'c3', function: { name: 'write_file', arguments: JSON.stringify({ path: WRITE_NAME, content: '# 产物\n' }) } }], usage: { prompt_tokens: 14, completion_tokens: 5 } },
  { content: '回读产物', tool_calls: [{ id: 'c4', function: { name: 'read_file', arguments: JSON.stringify({ path: WRITE_NAME }) } }], usage: { prompt_tokens: 18, completion_tokens: 5 } },
  { content: '读一个不存在的', tool_calls: [{ id: 'c5', function: { name: 'read_file', arguments: JSON.stringify({ path: 'definitely-missing.md' }) } }], usage: { prompt_tokens: 20, completion_tokens: 5 } },
  { content: '完成', usage: { prompt_tokens: 22, completion_tokens: 5 } },
];

const calls = [];
await runAgent({
  messages: [{ role: 'user', content: '看看 git 状态、读 README、写一份产物' }],
  model,
  cwd: OUT_DIR, // 定时通道：runAgent 的 cwd 是产出目录
  maxRounds: 6,
  unattended: true,
  toolHandlers: {
    ...scheduledToolHandlers({
      scheduledAgentChat: async () => ({}),
      webTools: { webSearch: async () => ({}), webFetch: async () => ({}) },
      toolShell: toolExec.toolShell,
      toolReadFile: toolExec.toolReadFile,
      runWriteTool: toolExec.runWriteTool,
      toolListDir: toolExec.toolListDir,
      toolGrep: toolExec.toolGrep,
      toolGlob: toolExec.toolGlob,
      toolGitStatus: toolExec.toolGitStatus,
      toolGitDiff: toolExec.toolGitDiff,
      toolGitLog: toolExec.toolGitLog,
      toolGitBranch: toolExec.toolGitBranch,
      toolGitCommit: toolExec.toolGitCommit,
      toolGitAdd: toolExec.toolGitAdd,
      callMcpTool: async () => ({}),
      prTools: { prList: async () => ({}), prView: async () => ({}), prDiff: async () => ({}), prReview: async () => ({}), prComment: async () => ({}) },
      unattended: true,
      contextCwd: REPO, // 会话项目目录
    }),
    chat: async () => SCRIPT.shift() || { content: '完成', usage: { prompt_tokens: 1, completion_tokens: 1 } },
  },
  onToolCall: (tc) => calls.push(tc),
});

const byName = (n) => calls.find((c) => c.name === n);

await check('真实链路：git_status 在项目里执行（不是 fatal: not a git repository）', () => {
  const c = byName('git_status');
  assert.ok(c, `git_status 没被调用，实际调用：${calls.map((x) => x.name).join(',')}`);
  const out = JSON.stringify(c.result || {});
  assert.ok(!/not a git repository/i.test(out), `git 跑错目录了：${out.slice(0, 200)}`);
  assert.match(out, /untracked-marker\.txt/, `git_status 没有读到项目的未跟踪文件：${out.slice(0, 200)}`);
  // 注意：onToolCall 拿到的是**进 handler 之前**的入参（agent-core 注入的宿主 cwd），
  // 所以断言要落在工具返回的实际执行目录上（result.cwd 由 exec.js 回填）
  assert.equal(c.result?.cwd, REPO, `git_status 实际执行目录不是项目：${c.result?.cwd}`);
});

await check('真实链路：read_file 的相对路径读到项目文件（不是产物目录 notFound）', () => {
  const c = byName('read_file');
  assert.ok(c, 'read_file 没被调用');
  const content = String((c.result && (c.result.content || c.result.text)) || '');
  assert.ok(!c.result?.notFound, `读不到（落到了 ${c.result?.cwd || '?'}）`);
  assert.ok(content.includes(README.split('\n')[0]), `读到的内容不对：${content.slice(0, 40)}`);
  console.log(`      · read_file 读到前 40 字：${content.slice(0, 40).replace(/\n/g, '\\n')}`);
});

await check('S-1：写完立刻用相对路径回读能读到（读类双根解析：ctxDir 未命中回落产出目录）', () => {
  const reads = calls.filter((c) => c.name === 'read_file');
  const back = reads.find((c) => String(c.args?.path) === WRITE_NAME);
  assert.ok(back, '没有执行「相对路径回读」这一步');
  assert.equal(back.result?.ok, true, `回读失败（落到 ${back.result?.cwd || '?'}）：${JSON.stringify(back.result).slice(0, 160)}`);
  assert.match(String(back.result?.content || ''), /# 产物/, '读到的不是刚写的那份产物');
  assert.equal(back.result?.path, path.join(OUT_DIR, WRITE_NAME), '相对路径回读没有落回产出目录');
});

await check('S-1 反例：两处都没有的文件仍返回 notFound（不能"读到了错误的文件"）', () => {
  const miss = calls.filter((c) => c.name === 'read_file').find((c) => String(c.args?.path) === 'definitely-missing.md');
  assert.ok(miss, '没有执行「读不存在文件」这一步');
  assert.equal(miss.result?.notFound, true, `不存在应返回 notFound，实际：${JSON.stringify(miss.result).slice(0, 160)}`);
});

await check('边界：写工具的相对路径落**产物目录**，绝不写进用户项目', () => {
  const c = byName('write_file');
  assert.ok(c, 'write_file 没被调用');
  assert.equal(c.result?.ok, true, `写入失败：${JSON.stringify(c.result).slice(0, 200)}`);
  assert.ok(fs.existsSync(path.join(OUT_DIR, WRITE_NAME)), `产物不在产出目录：${OUT_DIR}`);
  assert.ok(!fs.existsSync(path.join(REPO, WRITE_NAME)), '产物被写进了用户项目目录（contextCwd 不许影响写工具）');
});

console.log(`      · git_status stdout 片段：${String(JSON.stringify(byName('git_status')?.result || {})).slice(0, 160)}`);

fs.rmSync(WORK, { recursive: true, force: true });
fs.rmSync(USER_DATA, { recursive: true, force: true });
console.log(`\nscheduled-context-cwd: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);

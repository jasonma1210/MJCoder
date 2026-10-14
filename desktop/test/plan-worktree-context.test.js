// 批次 D 回归门禁：Plan 模式 / Worktree / 上下文治理 / Diff 三级还原
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../renderer/src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const chat = read('components/ChatArea.jsx');
const core = fs.readFileSync(path.join(__dirname, '../agent-core/index.js'), 'utf8');
const diffPanel = read('components/DiffReviewPanel.jsx');
const mainSrc = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '../main/preload.js'), 'utf8');

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// ── D1 Plan 模式 ──
check('Plan 模式在引擎层移除写工具', () => {
  assert.match(core, /PLAN_MODE_BLOCKED/);
  for (const t of ['write_file', 'edit_file', 'apply_patch', 'git_commit', 'git_add']) {
    assert.ok(core.includes(`'${t}'`), `写工具 ${t} 未列入阻断集`);
  }
  assert.match(core, /allTools = allTools\.filter\(\(t\) => !PLAN_MODE_BLOCKED/);
});

check('Plan 模式附加系统提示约束', () => {
  assert.match(core, /规划模式/);
  assert.match(core, /等待用户确认/);
});

check('runAgent 接受 planMode 参数', () => {
  assert.match(core, /planMode = false/);
});

check('ChatArea 规划模式/未选项目强制沙箱只读（双保险 + fail-safe）', () => {
  assert.match(chat, /planMode \|\| noProject \? 'read-only'/); // P0-B：planMode 或无项目均强制只读
  assert.match(chat, /const noProject = /);
  assert.match(chat, /规划模式/);
  assert.match(chat, /enablePlanMode/);
});

// ── D2 Worktree ──
check('worktree 模块存在且 IPC 已注册', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '../main/worktree.js')));
  for (const ch of ['worktree:create', 'worktree:list', 'worktree:promote', 'worktree:sync', 'worktree:remove']) {
    assert.ok(mainSrc.includes(`ipcMain.handle('${ch}'`), `缺少 IPC ${ch}`);
    assert.ok(preload.includes(ch.split(':')[1].replace(/^/, (m) => m)) || preload.includes(ch), `preload 未暴露 ${ch}`);
  }
});

check('worktree 存放于用户级目录且有上限保护', () => {
  const wt = fs.readFileSync(path.join(__dirname, '../main/worktree.js'), 'utf8');
  assert.match(wt, /\.mjcode', 'worktrees'/);
  assert.match(wt, /DEFAULT_LIMIT = 8/);
  assert.match(wt, /无法使用隔离工作区/, '非 Git 仓库需给出中文提示');
});

check('syncToLocal 不在 worktree 内解析主检出目录', () => {
  const wt = fs.readFileSync(path.join(__dirname, '../main/worktree.js'), 'utf8');
  const fn = wt.slice(wt.indexOf('async function syncToLocal'));
  assert.match(fn, /listWorktrees\(worktreePath\)/, '必须从 worktree list 取主检出目录');
  assert.match(fn, /未提交改动/, '主目录脏时必须 fail-closed');
});

check('Composer 提供本地/隔离工作区切换', () => {
  const cc = read('components/ComposerControls.jsx');
  assert.match(cc, /MODE_OPTIONS/);
  assert.match(cc, /value: 'worktree'/);
  assert.match(cc, /onModeChange/);
});

check('隔离模式下实际执行目录切到 worktree 副本', () => {
  assert.match(chat, /const cwd = \(runMode === 'worktree' && worktree\?\.path\)/);
  assert.match(chat, /window\.mjcode\.createWorktree/);
});

// ── D3 上下文治理 ──
check('上下文用量圆环组件存在', () => {
  assert.ok(fs.existsSync(path.join(SRC, 'components/ContextRing.jsx')));
  const ring = read('components/ContextRing.jsx');
  assert.match(ring, /上下文用量/);
  assert.match(ring, /AUTO_COMPACT_RATIO/);
});

check('token 估算与压缩函数已从引擎导出', () => {
  assert.match(core, /export function estimateTokens/);
  assert.match(core, /export function estimateMessagesTokens/);
  assert.match(core, /export async function compactHistory/);
});

check('/compact 已接到实际压缩', () => {
  assert.match(chat, /async function compactContext/);
  assert.match(chat, /compactHistory\(convo, selectedModel, window\.mjcode\.chat\)/);
});

// ── D4 Diff 三级还原 ──
check('Diff 解析已按 hunk 拆分', () => {
  assert.match(diffPanel, /hunks/);
  assert.match(diffPanel, /line\.startsWith\('@@'\)/);
  assert.match(diffPanel, /function hunkPatch/);
});

check('hunk 级还原走 git apply --reverse', () => {
  assert.match(mainSrc, /ipcMain\.handle\('tool:gitApplyHunk'/);
  assert.match(mainSrc, /\['apply', '--reverse'/);
  assert.match(preload, /gitApplyHunk/);
  assert.match(diffPanel, /还原此块/);
  assert.match(diffPanel, /rejectHunk/);
});

check('上一轮筛选只看 Agent 改动的文件', () => {
  assert.match(diffPanel, /agentFiles = \[\]/);
  assert.match(diffPanel, /lastTurnOnly/);
  assert.match(diffPanel, /上一轮/);
  assert.match(chat, /agentFilesOf/);
  assert.match(chat, /onAgentFilesChange/);
});

console.log(`\nPASS：${pass}/${total} 项通过`);
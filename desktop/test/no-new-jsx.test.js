// T0-3 回归门禁：渲染层渐进 TS 化「只减不增」
// 规则：renderer/src 下新增 .js/.jsx 文件一律拒绝——新组件/新模块必须 .ts/.tsx。
// 存量 37 个 .jsx + 13 个 .js 冻结为基线（grandfathered），随迭代逐个迁移、清单只减不增。
// 同时断言边界契约双文件齐备（contract.mjs 运行时 + contract.d.mts 类型，单一事实来源）。
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

const SRC = path.join(__dirname, '../renderer/src');

// 基线快照（2026-10-15 冻结；迁移一个删一个，禁止新增）
const BASELINE = new Set([
  'App.jsx',
  'components/AgentDock.jsx', 'components/ApprovalCard.jsx', 'components/ArchiveModal.jsx',
  'components/ChatArea.jsx', 'components/CodeView.jsx', 'components/CommandPalette.jsx',
  'components/ComposerControls.jsx', 'components/ContextMenu.jsx', 'components/ContextRing.jsx',
  'components/CreateProjectForm.jsx', 'components/Dashboard.jsx', 'components/DiffReviewPanel.jsx',
  'components/EcosystemModal.jsx', 'components/ErrorBoundary.jsx', 'components/feedback.jsx',
  'components/FilePreview.jsx', 'components/FileTree.jsx', 'components/FileViewerPane.jsx',
  'components/InlineAlert.jsx', 'components/MarketModal.jsx',
  'components/ModelSelector.jsx', 'components/Onboarding.jsx', 'components/PlusMenu.jsx',
  'components/ProjectPicker.jsx', 'components/RightPane.jsx', 'components/ScheduledTasks.jsx',
  'components/SettingsModal.jsx', 'components/Sidebar.jsx', 'components/StatusBar.jsx',
  'components/TeamSpace.jsx', 'components/ThreadList.jsx', 'components/TodoPanel.jsx',
  'components/WorktreeBar.jsx', 'components/icons/index.jsx',
  'main.jsx',
  'constants/approval.js', 'hooks/useVoice.js',
  'lib/agent.js', 'lib/api.js', 'lib/collab.js', 'lib/ecosystemApi.js',
  'lib/ipc.js', 'lib/linkOpen.js', 'lib/market.js', 'lib/mcpTools.js', 'lib/modelConfig.js',
  'lib/projectName.js',
]);

function walk(dir, rel = '') {
  const out = [];
  for (const ent of fs.readdirSync(path.join(dir, rel || '.'), { withFileTypes: true })) {
    const p = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) { if (ent.name !== 'node_modules') out.push(...walk(dir, p)); }
    else if (/\.(jsx?|tsx?)$/.test(ent.name)) out.push(p);
  }
  return out;
}

check('禁止新增 .js/.jsx：渲染层新文件必须 .ts/.tsx', () => {
  const current = walk(SRC).filter((f) => /\.jsx?$/.test(f));
  const added = current.filter((f) => !BASELINE.has(f));
  assert.deepEqual(added, [], `发现基线之外的新 JS/JSX 文件（请改用 .ts/.tsx）: ${added.join(', ')}`);
});

check('基线只减不增：已迁移为 TS 的文件应同步移出清单', () => {
  const current = new Set(walk(SRC));
  const stale = [...BASELINE].filter((f) => !current.has(f));
  assert.deepEqual(stale, [], `基线含已不存在的文件（迁移后请从 BASELINE 删除）: ${stale.join(', ')}`);
});

check('IPC 边界契约双文件齐备（运行时 + 类型声明）', () => {
  const root = path.join(__dirname, '../shared-ipc');
  assert.ok(fs.existsSync(path.join(root, 'contract.mjs')), '缺 contract.mjs（主渲染共用运行时）');
  assert.ok(fs.existsSync(path.join(root, 'contract.d.mts')), '缺 contract.d.mts（tsc 类型消费）');
});

check('渲染层 typecheck 门禁脚本存在', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../renderer/package.json'), 'utf8'));
  assert.match(pkg.scripts.typecheck, /tsc --noEmit/);
});

console.log(`\nno-new-jsx: ${pass}/${total} 通过`);
if (pass !== total) process.exitCode = 1;

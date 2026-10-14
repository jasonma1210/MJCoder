// 批次 A 回归门禁：三栏骨架与「同屏常驻」不得回退为全屏模态
// 背景：对标 Codex 的 Review Pane，Diff / 审批 / 代码视图必须同屏可见；
//      一旦退回 fixed inset-0 全屏遮罩，对话流就会被反复打断，体感退化
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../renderer/src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

const app = read('App.jsx');

check('右侧常驻面板组件存在', () => {
  assert.ok(fs.existsSync(path.join(SRC, 'components/RightPane.jsx')));
});

check('App 已挂载 RightPane 且传入三块面板内容', () => {
  assert.match(app, /import RightPane/);
  assert.match(app, /diffPanel=\{<DiffReviewPanel/);
  assert.match(app, /filesPanel=\{[\s\S]*?FileTree/);
  // 「代码」标签升级为「预览」：多文件标签 + 代码/Markdown/图片/PDF/音视频应用内预览
  assert.match(app, /previewPanel=\{[\s\S]*?FileViewerPane/);
});

check('Diff 面板不再使用全屏遮罩', () => {
  const src = read('components/DiffReviewPanel.jsx');
  assert.ok(!/fixed inset-0/.test(src), 'DiffReviewPanel 仍含 fixed inset-0');
  assert.ok(!/z-diff/.test(src), 'DiffReviewPanel 仍使用 z-diff 模态层级');
});

check('审批改为非模态悬浮卡片', () => {
  assert.ok(fs.existsSync(path.join(SRC, 'components/ApprovalCard.jsx')));
  const src = read('components/ApprovalCard.jsx');
  assert.ok(!/bg-overlay/.test(src), '审批卡片不应使用遮罩层');
  assert.match(src, /fixed bottom-14 right-4/, '审批卡片应为右下角悬浮');
  assert.ok(!fs.existsSync(path.join(SRC, 'components/ApprovalDialog.jsx')), '旧 ApprovalDialog 应已移除');
});

check('代码视图支持嵌入模式且无裸 z-index', () => {
  const src = read('components/CodeView.jsx');
  assert.match(src, /embedded/);
  assert.ok(!/z-40\b/.test(src), 'CodeView 仍有裸 z-40');
});

check('App 不再保留旧的 showDiff 模态状态', () => {
  assert.ok(!/showDiff/.test(app), 'App 仍残留 showDiff');
  assert.ok(!/setShowDiff/.test(app));
});

check('侧栏文件树已移出（避免与右侧面板重复）', () => {
  const sidebar = read('components/Sidebar.jsx');
  assert.ok(!/FileTree/.test(sidebar), 'Sidebar 仍引入 FileTree');
  assert.match(sidebar, /任务/, '侧栏区段应改名为「任务」');
});

check('面板开关快捷键已注册（⌘B / ⌘⌥B / ⌘P）', () => {
  assert.match(app, /setSidebarOpen\(\(v\) => !v\)/, '缺少 ⌘B 侧栏开关');
  assert.match(app, /e\.altKey[\s\S]{0,80}setPaneOpen/, '缺少 ⌘⌥B 面板开关');
  assert.match(app, /k === 'p'/, '缺少 ⌘P');
});

check('布局状态持久化（刷新后保持）', () => {
  assert.match(app, /mj_sidebar_open/);
  assert.match(app, /mj_pane_open/);
});

check('源码内无残留裸色（bg-black/、red-400、green-400、yellow-）', () => {
  const files = fs.readdirSync(path.join(SRC, 'components'))
    .filter((f) => f.endsWith('.jsx') && !f.includes('deprecated'))
    .map((f) => read(path.join('components', f)));
  const all = [...files, app].join('\n');
  const bad = all.match(/bg-black\/|text-red-400|text-green-400|text-blue-400|bg-yellow-/g);
  assert.equal(bad, null, `发现裸色：${[...new Set(bad || [])].join(', ')}`);
});

check('源码内无残留裸 z-index（z-50 / z-40）', () => {
  const files = fs.readdirSync(path.join(SRC, 'components'))
    .filter((f) => f.endsWith('.jsx') && !f.includes('deprecated'))
    .map((f) => read(path.join('components', f)));
  const all = [...files, app].join('\n');
  const bad = all.match(/\bz-50\b|\bz-40\b/g);
  assert.equal(bad, null, `发现裸 z-index：${[...new Set(bad || [])].join(', ')}`);
});

check('AGENTS.md 探测已上提到 App 层（消除面板切换重复探测）', () => {
  assert.match(app, /loadAgentsMd\(activeProject\.path\)/);
  assert.match(app, /agentsMd=\{agentsMd\}/);
  const chat = read('components/ChatArea.jsx');
  assert.ok(!/loadAgentsMd/.test(chat), 'ChatArea 仍在自行探测');
});

console.log(`\nPASS：${pass}/${total} 项通过`);
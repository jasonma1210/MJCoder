// 侧栏一级导航选中态门禁（2026-10-18）
//
// 用户实测反馈：「我选中的左侧菜单，虽然跳转的页面是对的，但是左侧的菜单没有被选中」。
// 真因两条，缺一都会复现：
//   ① 判据不互斥也不穷尽：此前只有「新建会话」传了 active，且写成 `!activeThread`。
//      定时任务页没有打开会话 → 该亮不亮；反之一旦有会话又可能两个一起亮。
//   ② 选中样式是 `bg-hover`，与 hover 同色 → 即使 active 传对了，视觉上仍等于没选中。
//
// 覆盖方式：① 用**行为**测（直接 import lib/navState.ts，穷举 16 种组合）；
//          ② 用**源码契约**测（select-bg/select-fg + aria-current 是 DOM 部分，见渲染层验收）。
// 视觉最终由 Playwright 验（选中项 backgroundColor 非透明 + 与普通项不同色）。
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let pass = 0;
let total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

const SRC = path.join(__dirname, '../renderer/src');
const APP = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');
const SIDEBAR = fs.readFileSync(path.join(SRC, 'components/Sidebar.jsx'), 'utf8');

// 注释里的示例不算数：抹成空格、保留行号
function blankComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}
const app = blankComments(APP);
const sidebar = blankComments(SIDEBAR);

(async () => {
  const { activeNavOf } = await import('../renderer/src/lib/navState.ts');

  // ── 行为：穷举 16 种组合 ──
  const combos = [];
  for (const showScheduled of [false, true])
    for (const showDashboard of [false, true])
      for (const showEcosystem of [false, true])
        for (const hasActiveThread of [false, true])
          combos.push({ showScheduled, showDashboard, showEcosystem, hasActiveThread });

  await check('穷举 16 种视图组合：返回值只可能是四个已定义字面量', () => {
    const allowed = new Set(['new', 'scheduled', 'ecosystem', '']);
    for (const c of combos) {
      const got = activeNavOf(c);
      assert.ok(allowed.has(got), `${JSON.stringify(c)} → ${got}`);
    }
  });

  await check('定时任务页永远选中「定时任务」（哪怕同时有打开的会话）', () => {
    for (const c of combos.filter((x) => x.showScheduled)) {
      assert.equal(activeNavOf(c), 'scheduled', JSON.stringify(c));
    }
  });

  await check('生态中心打开时选中「生态中心」（定时任务优先）', () => {
    for (const c of combos.filter((x) => !x.showScheduled && x.showEcosystem)) {
      assert.equal(activeNavOf(c), 'ecosystem', JSON.stringify(c));
    }
  });

  await check('工作台与会话中：三项都不亮（避免与一级导航语义混淆）', () => {
    assert.equal(activeNavOf({ showScheduled: false, showDashboard: true, showEcosystem: false, hasActiveThread: false }), '');
    assert.equal(activeNavOf({ showScheduled: false, showDashboard: false, showEcosystem: false, hasActiveThread: true }), '');
  });

  await check('新会话页（什么都没有打开）才选中「新建会话」', () => {
    assert.equal(activeNavOf({ showScheduled: false, showDashboard: false, showEcosystem: false, hasActiveThread: false }), 'new');
  });

  await check('互斥：任一组合下被选中的一级入口不超过一个', () => {
    for (const c of combos) {
      const got = activeNavOf(c);
      const lit = ['new', 'scheduled', 'ecosystem'].filter((k) => k === got);
      assert.ok(lit.length <= 1, `${JSON.stringify(c)} → ${got}`);
    }
  });

  // ── 连线契约：组件必须真的用上这个判定 ──
  await check('App 把三个视图标志作为 view 传给 Sidebar', () => {
    assert.match(app, /view=\{\{\s*showScheduled,\s*showDashboard,\s*showEcosystem\s*\}\}/,
      '缺少 view={{ showScheduled, showDashboard, showEcosystem }}');
  });

  await check('Sidebar 用 activeNavOf 计算，且三个入口各自绑定字面量', () => {
    assert.match(sidebar, /activeNavOf\(\{/, 'Sidebar 未使用 activeNavOf');
    assert.match(sidebar, /hasActiveThread: !!activeThread/);
    for (const key of ['new', 'scheduled', 'ecosystem']) {
      assert.match(sidebar, new RegExp(`active=\\{activeNav === '${key}'\\}`),
        `NavItem「${key}」缺少 active={activeNav === '${key}'}`);
    }
  });

  await check('NavItem 输出 aria-current="page"（语义 + 可测锚点）', () => {
    assert.match(sidebar, /aria-current=\{active \? 'page' : undefined\}/);
  });

  await check('选中态用 select-bg/select-fg 专用令牌，不允许退回 bg-hover', () => {
    assert.match(sidebar, /active \? 'bg-select-bg text-select-fg/, '选中态必须用 select-bg/select-fg');
    const activeArm = sidebar.slice(sidebar.indexOf("active ? '") + 10, sidebar.indexOf("' : '"));
    assert.ok(!/bg-hover/.test(activeArm), `选中态仍是 bg-hover（与 hover 同色）：${activeArm}`);
  });

  console.log(`\nsidebar-nav-active: ${pass}/${total} 通过`);
  if (pass !== total) process.exitCode = 1;
})();

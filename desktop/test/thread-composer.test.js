// 批次 C 回归门禁：项目→任务二级结构、Composer 任务控制台、steer/queue
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
const chat = read('components/ChatArea.jsx');
const sidebar = read('components/Sidebar.jsx');
const store = fs.readFileSync(path.join(__dirname, '../main/localStore.js'), 'utf8');
const api = read('lib/api.js');
const mainSrc = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');

check('ThreadList 二级树组件存在', () => {
  assert.ok(fs.existsSync(path.join(SRC, 'components/ThreadList.jsx')));
});

check('侧栏使用 ThreadList 且不再自绘平铺聊天列表', () => {
  assert.match(sidebar, /import ThreadList/);
  assert.match(sidebar, /<ThreadList/);
  assert.ok(!/threads\.map/.test(sidebar), '侧栏仍有平铺 threads.map');
});

check('线程按项目分组（projectPath 匹配）', () => {
  const tl = read('components/ThreadList.jsx');
  assert.match(tl, /threads\.filter\(\(t\) => \(t\.projectPath \|\| t\.cwd\) === p\.path\)/);
  assert.match(tl, /未归属项目/, '应处理无项目归属的孤儿线程');
});

check('线程三色状态指示齐备（完成/待审批/运行中）', () => {
  const tl = read('components/ThreadList.jsx');
  for (const s of ['running', 'awaiting_approval', 'done', 'idle']) {
    assert.match(tl, new RegExp(`${s}:`), `缺少状态 ${s}`);
  }
});

check('localStore 线程记录 projectPath 与 status', () => {
  assert.match(store, /projectPath/);
  assert.match(store, /status: status \|\| 'idle'/);
  assert.match(store, /setThreadStatus/);
});

check('线程列表支持按项目筛选', () => {
  assert.match(store, /listThreads\(projectPath\)/);
  assert.match(mainSrc, /local:threads\/list[\s\S]{0,120}projectPath/);
  assert.match(api, /threads: \(projectPath\)/);
});

check('preload 暴露线程状态通道', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../main/preload.js'), 'utf8');
  assert.match(preload, /localSetThreadStatus/);
});

check('Composer 任务控制台组件存在并含三控件', () => {
  const cc = read('components/ComposerControls.jsx');
  assert.match(cc, /PERMISSION_OPTIONS/);
  assert.match(cc, /SANDBOX_OPTIONS/);
  assert.match(cc, /ModelSelector/);
});

check('模型选择已移入 Composer（顶栏不再重复）', () => {
  const headerBlock = app.match(/<header[\s\S]*?<\/header>/);
  assert.ok(!/ModelSelector/.test(headerBlock[0]), '顶栏仍含 ModelSelector，应移入 Composer');
  assert.match(chat, /<ComposerControls/);
});

check('斜杠命令菜单存在且含 Codex 同款命令', () => {
  assert.match(chat, /SLASH_COMMANDS/);
  for (const c of ['/plan', '/review', '/compact', '/status', '/init', '/clear']) {
    assert.ok(chat.includes(c), `缺少斜杠命令 ${c}`);
  }
  assert.match(chat, /slashOpen/, '需有斜杠菜单开合状态');
  assert.match(chat, /ArrowDown/, '需支持方向键选择');
});

check('steer（Enter 当轮引导）已实现', () => {
  assert.match(chat, /function steer\(/);
  assert.match(chat, /if \(loading && onSteer\) \{ onSteer\(input\)/);
  assert.match(chat, /运行中：Enter 当轮引导/);
});

check('queue（Tab 排队下一轮）已实现', () => {
  assert.match(chat, /function queueNext\(/);
  assert.match(chat, /if \(e\.key === 'Tab' && loading && input\.trim\(\)\)/);
  assert.match(chat, /setQueued\(\(q\) => \[\.\.\.q, t\]\)/);
  assert.match(chat, /已排队/);
});

check('排队指令在本轮结束后自动接力', () => {
  assert.match(chat, /if \(next\) setTimeout\(\(\) => send\(next, currentThread\), 0\)/);
});

check('发送时置线程状态为 running，完成后置 done', () => {
  assert.match(chat, /onThreadStatus\?\.\('running'\)/);
  assert.match(chat, /onThreadStatus\?\.\('done'\)/);
});

check('密钥缺失提示改为引导本机设置', () => {
  assert.match(chat, /请在本机模型设置中重新填写 API Key/);
  assert.ok(!/请重新登录后重试/.test(chat), '仍有旧的登录态提示');
});

check('App 已向 ChatArea 传递控制台所需 props', () => {
  assert.match(app, /providers=\{allProviders\}/);
  assert.match(app, /onSelectModel=\{setSelectedModel\}/);
  assert.match(app, /onApprovalChange=/);
  assert.match(app, /onThreadStatus=/);
});

// ── P1-D：待审批状态闭环（此前 awaiting_approval 是死代码：有渲染无写入）──
check('审批挂起即置线程状态 awaiting_approval（写入端闭环）', () => {
  const card = read('components/ApprovalCard.jsx');
  assert.match(app, /<ApprovalCard/);
  assert.match(app, /onPendingChange=/);
  assert.match(app, /awaiting_approval/);
  assert.match(card, /onPendingChange/);
  // 2026-10-15：审批卡改为 FIFO 队列后，上报由「队列是否非空」驱动，
  // 不再是在两处各写死一次 true/false。契约不变：有挂起必上报、清空必上报恢复。
  assert.match(card, /pendingCbRef\.current\?\.\(queue\.length > 0\)/, '有挂起需上报（队列非空）');
  assert.match(card, /\[queue\.length\]/, '队列清空需上报恢复（依赖队列长度）');
  assert.match(card, /const pending = queue\[0\]/, '取队首展示，保证上报与展示同一条');
});

check('侧栏待审批徽标可点击直达审批卡', () => {
  const tl = read('components/ThreadList.jsx');
  const card = read('components/ApprovalCard.jsx');
  assert.match(tl, /mjcode:focus-approval/, '徽标点击应派发直达事件');
  assert.match(tl, /e\.stopPropagation\(\); window\.dispatchEvent/, '徽标按钮需阻止冒泡并派发事件');
  assert.match(card, /addEventListener\('mjcode:focus-approval'/, '审批卡需监听直达事件');
  assert.match(card, /setFlash\(true\)/, '直达时应高亮闪现');
});

console.log(`\nPASS：${pass}/${total} 项通过`);
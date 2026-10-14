// 设置页与产品逻辑门禁：把「假可用 / 空态伪装 / 设置项不生效」三类问题固化为静态检查
//
// 背景（真机反馈，均为用户直接踩到的问题）：
//   ① 设置页导航里登记了「浏览器」「Git」两项，正文却没有任何实现分支
//      → 点进去只有标题和空白。假可用比不显示入口更伤信任。
//   ② 新建任务页把上次打开的项目名当成已选事实挂在输入框上方
//      → 空态不得伪装成已选（项目/分支/上下文环只在进入会话后才有意义）。
//   ③ 设置项必须真的被消费：只在设置页存一个值、没有任何代码读它，就是假开关。
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'renderer', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

/** 递归收集渲染层 JS/JSX 文件（排除样式目录：主题变量不是「设置项」） */
function listFiles(dir = SRC, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'styles' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(full, out);
    else if (/\.(jsx?|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
}
const files = listFiles();

const settings = read('components/SettingsModal.jsx');

check('设置导航每一项都有正文实现（杜绝空页面）', () => {
  const navIds = [...settings.matchAll(/\{ id: '([a-zA-Z]+)', icon:/g)].map((m) => m[1]);
  const bodyIds = [...settings.matchAll(/tab === '([a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.ok(navIds.length >= 8, `只解析到 ${navIds.length} 个导航项，解析逻辑可能失效`);
  const missing = navIds.filter((id) => !bodyIds.includes(id));
  assert.deepEqual(missing, [], `以下导航项点进去是空白页：${missing.join(', ')}`);
});

check('正文没有孤儿设置分支（导航项与实现一一对应）', () => {
  const navIds = [...settings.matchAll(/\{ id: '([a-zA-Z]+)', icon:/g)].map((m) => m[1]);
  const bodyIds = [...new Set([...settings.matchAll(/tab === '([a-zA-Z]+)'/g)].map((m) => m[1]))];
  const orphans = bodyIds.filter((id) => !navIds.includes(id));
  assert.deepEqual(orphans, [], `以下实现没有导航入口，用户无法到达：${orphans.join(', ')}`);
});

check('浏览器 / Git 设置页有真实内容（不再回落「即将上线」）', () => {
  assert.ok(!/\['browser', 'git'\]\.includes\(tab\)/.test(settings),
    '仍存在 browser/git 合并占位分支');
  assert.match(settings, /\{tab === 'browser' && <BrowserTab/);
  assert.match(settings, /\{tab === 'git' && <GitTab/);
  // 两个页面必须各自有可读内容，而不是一句「开发中」
  const browserBody = settings.match(/function BrowserTab\([\s\S]*?\n\}/);
  const gitBody = settings.match(/function GitTab\([\s\S]*?\n\}/);
  assert.ok(browserBody && browserBody[0].length > 600, 'BrowserTab 内容过薄，疑似占位');
  assert.ok(gitBody && gitBody[0].length > 600, 'GitTab 内容过薄，疑似占位');
});

check('设置页顶部避开 macOS 交通灯（hiddenInset 窗口）', () => {
  // 主窗口是 titleBarStyle: 'hiddenInset'，交通灯悬浮在内容左上角且永远在最上层
  const main = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8');
  assert.match(main, /titleBarStyle: 'hiddenInset'/,
    '窗口标题栏样式已变，请同步核对交通灯安全区');
  assert.match(settings, /WebkitAppRegion: 'drag'/,
    '设置页缺少拖拽安全区，交通灯会压住左上角内容');
  // 只禁「渲染出来的按钮」，注释里记录这段历史是允许的
  assert.ok(!/>\s*← 返回应用\s*</.test(settings),
    '左上角仍渲染返回按钮：该位置被交通灯覆盖，既看不清也点不到');
  assert.match(settings, /aria-label="关闭设置"/, '设置页缺少明确关闭出口');
});

check('设置项没有假开关（写入的键必须有人读取）', () => {
  const setKeys = new Set();
  const readKeys = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/localStorage\.setItem\(\s*'([^']+)'/g)) setKeys.add(m[1]);
    for (const m of src.matchAll(/localStorage\.getItem\(\s*'([^']+)'/g)) readKeys.add(m[1]);
    // App 的 loadJSON(key, fallback) 内部即 getItem
    for (const m of src.matchAll(/loadJSON\(\s*'([^']+)'/g)) readKeys.add(m[1]);
  }
  assert.ok(setKeys.size > 5, `只找到 ${setKeys.size} 个设置键，解析逻辑可能失效`);
  const dead = [...setKeys].filter((k) => !readKeys.has(k));
  assert.deepEqual(dead, [], `以下设置写入了但无人读取（假开关）：${dead.join(', ')}`);
});

check('链接打开方式设置真正生效（有消费方）', () => {
  const linkOpen = read('lib/linkOpen.js');
  assert.match(linkOpen, /export function getLinkOpenMode/);
  assert.match(linkOpen, /export async function openLinkByMode/);
  // 至少有一个渲染层组件按策略分发链接点击
  const consumers = files.filter((f) => /openLinkByMode/.test(fs.readFileSync(f, 'utf8')));
  assert.ok(consumers.length > 0, 'openLinkByMode 没有任何调用方，设置形同虚设');
});

check('新建任务不显示工作区 chip（空态不得伪装成已选）', () => {
  const chat = read('components/ChatArea.jsx');
  // 项目 / 分支 / 上下文环三段必须在 workspaceBound 门控之内
  const gate = chat.match(/\{workspaceBound && \(([\s\S]*?)\n      \)\}/);
  assert.ok(gate, '未找到 workspaceBound 门控块');
  for (const marker of ['IconFolder', 'IconGitBranch', 'ContextRing']) {
    assert.ok(gate[1].includes(marker),
      `${marker} 不在 workspaceBound 门控内：新建任务页仍会显示工作区信息`);
  }
  assert.match(chat, /workspaceBound=\{!!thread\}/,
    'Composer 未按「是否已进入会话」传入 workspaceBound');
  // 欢迎页副标题同样受「主动选择」门控：残留的上次项目不得当默认事实展示
  const hero = chat.match(/我们要构建什么？[\s\S]*?<\/p>/);
  assert.ok(hero, '未找到欢迎页副标题区');
  assert.match(hero[0], /projectPicked/,
    '欢迎页副标题未按 projectPicked 门控：重启后仍会说「在上次项目中」');
  // ambient 个性化建议同样只在主动选择的项目上生成
  const ambient = chat.match(/ambient 建议[\s\S]*?\}\);/);
  assert.ok(ambient && /projectPicked/.test(ambient[0]),
    'ambient 建议未按 projectPicked 门控：欢迎页仍会围绕上次项目出建议卡片');
});

check('新建任务页有「打开/创建项目」入口（此前只有 ⌘O 隐式入口）', () => {
  const chat = read('components/ChatArea.jsx');
  assert.ok(chat.includes('打开或创建项目'),
    '欢迎页缺少「打开或创建项目」入口（ProjectPicker 无法从新建任务页到达）');
  assert.match(chat, /onClick=\{onOpenProjectPicker\}/,
    '欢迎页入口未接线到 onOpenProjectPicker');
});

check('项目右键菜单可用（打开文件夹 / 重命名 / 移除）', () => {
  const list = read('components/ThreadList.jsx');
  assert.match(list, /onContextMenu=\{/,
    '项目行没有 onContextMenu：无法右键打开对应路径');
  for (const item of ['打开文件夹', '重命名', '从列表中移除']) {
    assert.ok(list.includes(item), `右键菜单缺少「${item}」`);
  }
  assert.match(list, /openPath\??\.\(\{ path: project\.path \}\)/,
    '右键「打开文件夹」未调用主进程 openPath');
  const menu = read('components/ContextMenu.jsx');
  assert.match(menu, /e\.key === 'Escape'/, '右键菜单缺少 Esc 关闭');
  assert.match(menu, /document\.addEventListener\('mousedown'/, '右键菜单点击外部不关闭');
});

check('文件预览覆盖代码 / Markdown / 图片 / PDF', () => {
  const preview = read('components/FilePreview.jsx');
  assert.match(preview, /ReactMarkdown/, 'Markdown 未按富文本渲染');
  assert.match(preview, /meta\.kind === 'image'/, '缺少图片渲染分支');
  assert.match(preview, /meta\.kind === 'pdf'/, '缺少 PDF 渲染分支');
  assert.match(preview, /highlightLine/, '代码未接语法高亮');
  assert.match(preview, /meta\.kind === 'binary'|looksBinary/, '缺少不可预览文件的诚实降级');
  // 二进制白名单与体积上限在主进程把守
  const main = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8');
  assert.match(main, /PREVIEW_MAX_BYTES/, '主进程缺少预览体积上限');
  assert.match(main, /ipcMain\.handle\('file:preview'/, '缺少 file:preview IPC');
  const rightPane = read('components/RightPane.jsx');
  assert.match(rightPane, /id: 'preview'/, '右侧面板缺少预览标签');
});

check('拖拽入参覆盖整个对话区（不只输入框那一小块）', () => {
  const chat = read('components/ChatArea.jsx');
  assert.match(chat, /window\.addEventListener\('dragover'/, '缺少窗口级 dragover 监听');
  assert.match(chat, /alreadyHandled = e\.defaultPrevented/,
    '未区分「输入框已处理」与「窗口兜底」，会导致重复入参');
  assert.match(chat, /松开以把文件加入对话/, '缺少拖拽视觉反馈');
});

console.log(`\nPASS：${pass}/${total} 项通过`);

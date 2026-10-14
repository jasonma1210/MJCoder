// 项目切换状态残留门禁：切换项目时必须清空与上一个项目绑定的状态
//
// 背景（真实审查发现，非崩溃型）：
//   切换项目后，右侧「代码」标签仍显示上一个项目的文件，
//   且 relPath 以新项目根为前缀计算 → 显示错误的相对路径；
//   ChatArea 里的隔离工作区（worktree）也仍指向旧项目的副本，
//   Agent 会把改动写进错误目录 —— 这类错误后果严重但无任何报错。
//
// 为什么需要门禁：
//   这是典型的「静默失效」，靠人工 review 极易漏看，
//   而且不会有任何报错提示，只能靠用户发现界面不对。
//
// 判定规则：
//   1. 项目切换函数（selectProject / onSelectProject 等）内必须清空 viewFile
//   2. ChatArea 必须监听 project?.path 变化并重置 worktree / runMode
//   3. 这些重置动作必须真实调用对应的 setter（防拼写错误形同虚设）
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
const pane = read('components/RightPane.jsx');

// ChatArea 里 project?.path 出现在多个 effect 中（记忆、建议、reset），
// 必须精确定位「切项目重置」那个：它以 setWorktree(null) 开头且依赖数组含 project?.path
// P1-6：依赖数组从「精确等于 [project?.path]」放宽为「以 project?.path 开头」。
// 原因：exhaustive-deps 修复时给该 effect 补了 onAgentFilesChange（稳定的 useState
// setter，语义正确且不改变行为），精确匹配会因此误报「找不到 effect」。
// 本测试的意图是验证重置逻辑存在且完整，不是锁定依赖列表的写法。
function findProjectResetEffect(src) {
  const re = /useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[project\?\.path[^\]]*\]\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    // 含 worktree 重置的那个才是目标 effect
    if (/setWorktree\(/.test(m[1])) return m[1];
  }
  return null;
}

const resetBody = findProjectResetEffect(chat);

check('App：切换项目时清空预览标签', () => {
  const m = app.match(/function selectProject[\s\S]*?\n  }/);
  assert.ok(m, '未找到 selectProject 函数');
  // 预览栏由单文件 viewFile 升级为多标签 openFiles/activeFilePath，
  // 清空动作收敛到 closeAllFiles()（两个状态必须一起清，只清一个是半吊子修复）
  assert.match(m[0], /closeAllFiles\(\)/,
    'selectProject 未清空预览标签：切项目后预览栏仍显示上一个项目的文件');
  assert.match(app, /const closeAllFiles = \(\) => \{[\s\S]{0,160}?setOpenedFiles\(\[\]\)[\s\S]{0,80}?setActiveFilePath\(null\)/,
    'closeAllFiles 未同时清空 openFiles 与 activeFilePath');
});

check('App：切换项目时清空 Agent 改动文件集', () => {
  const m = app.match(/function selectProject[\s\S]*?\n  }/);
  assert.ok(m, '未找到 selectProject 函数');
  assert.match(m[0], /setAgentFiles\(\[\]\)/,
    'selectProject 未重置 agentFiles：Diff 面板「上一轮」筛选会带上一个项目的文件');
});

check('ChatArea：监听 project.path 变化并重置项目级状态', () => {
  assert.ok(resetBody !== null,
    'ChatArea 未监听 project?.path 变化并重置状态（缺少含 setWorktree 的 effect）');
});

check('ChatArea：切项目时清空隔离工作区', () => {
  assert.ok(resetBody, '未找到切项目重置 effect');
  assert.match(resetBody, /setWorktree\(null\)/,
    '未清空 worktree：Agent 会把改动写进上一个项目的隔离副本');
  assert.match(resetBody, /setRunMode\('local'\)/,
    '未重置运行模式：切换项目后仍处于隔离工作区模式');
});

check('ChatArea：切项目时清空工具调用与流式输出', () => {
  assert.ok(resetBody, '未找到切项目重置 effect');
  assert.match(resetBody, /setToolCalls\(\[\]\)/, '未清空工具调用列表');
  assert.match(resetBody, /setStreamingText\(''\)/, '未清空流式输出（会显示上一个项目的残留文本）');
  assert.match(resetBody, /setQueued\(\[\]\)/, '未清空排队队列（会把上一个项目的指令排进新项目）');
});

check('ChatArea：切项目时重置 Agent 文件索引并通知父级', () => {
  assert.ok(resetBody, '未找到切项目重置 effect');
  assert.match(resetBody, /agentFilesRef\.current = new Set\(\)/, '未重置 agentFilesRef');
  assert.match(resetBody, /onAgentFilesChange\?\.\(\[\]\)/, '未通知父级清空 agentFiles');
});

check('RightPane：收起时隐藏而非卸载（保住常驻语义与状态）', () => {
  assert.ok(!/if \(!open\) return null/.test(pane),
    'RightPane 收起时直接卸载：重新展开会重载 git diff、重建文件树、丢失已查看文件');
  assert.match(pane, /hidden/, '收起时未使用 hidden 类隐藏');
  assert.match(pane, /aria-hidden/, '收起时未设置 aria-hidden，无障碍属性缺失');
});

check('切项目重置不依赖用户可见的错误反馈（静默失效防护）', () => {
  // 这些重置都是「预防性」的，不应抛错或依赖条件判断
  const m = chat.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[project\?\.path\]\)/);
  assert.ok(m, '未找到 project?.path 的重置 effect');
  const body = m[0];
  // 不允许被 if (xxx) 守卫包住导致「某些情况不重置」
  assert.ok(!/if\s*\([^)]*\)\s*\{?\s*setWorktree/.test(body),
    'setWorktree 被条件守卫，新项目可能不触发重置');
});

check('工具执行失败原因必须可见（可观测性）', () => {
  // agent-core 工具失败时返回 { error: message }。
  // 若界面只展示 stdout/stderr，用户只能看到工具名、看不到失败原因 ——
  // 这类「静默失效」会让排查成本极高，且没有任何报错提示。
  assert.match(chat, /result\?\.error/, '未展示工具 result.error');
  assert.match(chat, /tc\.result\?\.error/, '运行中未展示工具 result.error');
  assert.match(chat, /bg-danger-bg[\s\S]{0,80}result\?\.error|result\?\.error[\s\S]{0,200}bg-danger-bg/,
    '工具错误未使用危险色语义 token，视觉上无法与正常输出区分');
});

check('历史重放的 tool 卡片与运行中卡片一致', () => {
  // 两处展示逻辑若不同步，用户会看到「重进线程后错误信息消失」。
  // 判定方式：stdout / stderr / error 三个字段各应在两处卡片都出现。
  const cardRegion = (src, marker) => {
    const i = src.indexOf(marker);
    assert.ok(i >= 0, `未找到卡片区域标记 ${marker}`);
    return src.slice(i, i + 2200);
  };
  const live = cardRegion(chat, 'toolCalls.map((tc, i) =>');
  const replay = cardRegion(chat, 'const tr = toolResults.get(tc.id)');
  for (const field of ['result?.stdout', 'result?.stderr', 'result?.error']) {
    assert.ok(live.includes(field), `运行中卡片缺少 ${field}`);
    assert.ok(replay.includes(field), `历史重放卡片缺少 ${field}`);
  }
});

// ── P1-E/F/G/H/M：第三阶段产品闭环门禁 ──
check('P1-F：401 后回退登录页（auth-changed 监听闭环）', () => {
  assert.match(app, /addEventListener\('auth-changed'/,
    'App 未监听 auth-changed：401 清 token 后仍是伪登录态');
  assert.match(app, /setToken\(null\)/, '401 后未清 token 状态');
  assert.match(app, /setLocalModeState\(false\)/, '401 后未退出离线态兜底，可能卡在离线模式');
  const apiSrc = read('lib/api.js');
  assert.match(apiSrc, /dispatchEvent\(new Event\('auth-changed'\)\)/, 'api 401 分支未派发 auth-changed');
});

check('P1-F：设置页提供退出登录入口', () => {
  const settings = read('components/SettingsModal.jsx');
  assert.match(settings, /退出登录/, '设置页无退出登录入口');
  assert.match(settings, /localStorage\.removeItem\('mj_token'\)/, '退出登录未清 token');
});

check('P1-E：在线模式隐藏归档入口（服务端归档 API 未实现）', () => {
  assert.match(app, /onOpenArchive=\{localMode \?/, 'App 未按 localMode 门控归档入口');
  const sidebar = read('components/Sidebar.jsx');
  assert.match(sidebar, /\{onOpenArchive && <NavItem/, '侧栏归档入口未按传入回调条件渲染');
});

check('P1-G：切会话即清空消息，拉取完成前不渲染旧消息', () => {
  assert.match(chat, /const msgReqRef = useRef\(0\)/, '缺少请求序号 ref（竞态防护）');
  assert.match(chat, /setMessages\(\[\]\);\s*\/\/ 先清空/, '切会话未先清空消息：拉取期间旧会话消息串显');
  assert.match(chat, /if \(reqId !== msgReqRef\.current\) return/, '迟到响应未按序号丢弃（A→B→A 竞态）');
});

check('P1-H：隔离工作区收口三动作接线（worktree 只建不收修复）', () => {
  assert.match(chat, /import WorktreeBar/, 'ChatArea 未引入 WorktreeBar');
  assert.match(chat, /<WorktreeBar/, 'WorktreeBar 未挂载');
  assert.match(chat, /onClosed=\{\(\) => \{ setWorktree\(null\); setRunMode\('local'\); \}\}/,
    '收口后未重置 worktree/runMode 状态');
  const bar = read('components/WorktreeBar.jsx');
  for (const fn of ['syncWorktree', 'promoteWorktree', 'removeWorktree']) {
    assert.match(bar, new RegExp(`window\\.mjcode\\.${fn}`), `收口动作缺少 ${fn} 调用`);
  }
  assert.match(bar, /合并回主目录/);
  assert.match(bar, /提升为分支/);
});

check('P1-M：MCP 配置出口剥离 env（敏感变量不出本机）', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
  assert.match(mainSrc, /map\(\(\{ env, \.\.\.rest \}\) => rest\)/,
    'mcp:getConfig 未剥离 env：用户配置的 API Key 会跨 IPC 进入渲染层');
});

console.log(`\nPASS：${pass}/${total} 项通过`);
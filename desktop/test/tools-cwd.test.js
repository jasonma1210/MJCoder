// 工具层集成测试：cwd 贯通 / 命令注入回归 / applyPatch / git 全套 / 项目探测
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const Module = require('module');

// ── electron stub ──
const handlers = new Map();
const noop = () => {};
// P0-2 新审批协议：捕获 tool:approval-response 全局监听器；
// FakeBrowserWindow.send 收到 tool:approval-request 后 5ms 回带 approvalId 的「允许一次」
let approvalResponseCb = null;
const ipcMain = {
  handle: (ch, fn) => handlers.set(ch, fn),
  on: (channel, cb) => { if (channel === 'tool:approval-response') approvalResponseCb = cb; },
  once: noop,
};
function autoRespondApproval(channel, payload) {
  if (channel === 'tool:approval-request' && approvalResponseCb) {
    setTimeout(() => approvalResponseCb({}, { approvalId: payload?.approvalId, decision: 'once' }), 5);
  }
}
class FakeBrowserWindow {
  constructor() { this.webContents = { setWindowOpenHandler: noop, openDevTools: noop, send: autoRespondApproval }; }
  loadURL() {} loadFile() {} on() {}
  isMinimized() { return false; } restore() {} focus() {}
  getBounds() { return { width: 1600, height: 1000 }; }
}
const electronStub = {
  app: { whenReady: () => Promise.resolve(), on: noop, requestSingleInstanceLock: () => true, getPath: () => '/tmp/mjcode-test', isPackaged: false, quit: noop },
  BrowserWindow: FakeBrowserWindow,
  ipcMain,
  shell: { openExternal: noop },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
};
const electronPath = require.resolve('electron');
const stubModule = new Module(electronPath, null);
stubModule.filename = electronPath;
stubModule.loaded = true;
stubModule.exports = electronStub;
require.cache[electronPath] = stubModule;

require('../main/main.js');

// ── 搭建临时 git 仓库 ──
const REPO = '/tmp/mjcoder-test-repo';
const PWNED = '/tmp/mjcoder-pwned-marker';
fs.rmSync(REPO, { recursive: true, force: true });
fs.rmSync(PWNED, { force: true });
fs.mkdirSync(REPO, { recursive: true });
fs.writeFileSync(path.join(REPO, 'app.js'), 'const a = 1;\nconsole.log(a);\n');
execFileSync('git', ['init'], { cwd: REPO });
execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: REPO });
execFileSync('git', ['config', 'user.name', 'test'], { cwd: REPO });
execFileSync('git', ['add', '.'], { cwd: REPO });
execFileSync('git', ['commit', '-m', 'init'], { cwd: REPO });
fs.writeFileSync(path.join(REPO, 'app.js'), 'const a = 1;\nconst b = 2;\nconsole.log(a, b);\n');
fs.writeFileSync(path.join(REPO, 'new.txt'), 'hello\n');

(async () => {
  const h = (name) => handlers.get(name);

  // 1. gitStatus 带 cwd：应报告 app.js 修改 + new.txt 未跟踪
  const st = await h('tool:gitStatus')({}, { cwd: REPO });
  console.log('[1] gitStatus(cwd):', JSON.stringify(st.stdout.trim().split('\n')));
  if (!st.stdout.includes('app.js') || !st.stdout.includes('new.txt')) { console.error('FAIL: gitStatus 未反映仓库变更'); process.exit(1); }

  // 2. gitDiff 带 cwd：应包含 b 变量
  const df = await h('tool:gitDiff')({}, { cwd: REPO });
  if (!df.stdout.includes('const b = 2')) { console.error('FAIL: gitDiff 内容不符'); process.exit(1); }
  console.log('[2] gitDiff(cwd) 含 const b = 2 ✓');

  // 3. probeProject
  const probe = await h('tool:probeProject')({}, { path: REPO });
  console.log('[3] probe:', JSON.stringify(probe));
  if (!probe.branch || probe.fileCount < 2) { console.error('FAIL: 探测结果异常'); process.exit(1); }

  // 4. grep 注入回归：恶意 pattern 不得执行 shell
  const evil = 'x"; touch /tmp/mjcoder-pwned-marker; echo "';
  const g = await h('tool:grep')({}, { pattern: evil, path: REPO });
  if (fs.existsSync(PWNED)) { console.error('FAIL: 命令注入成功执行！'); process.exit(1); }
  console.log('[4] grep 注入未生效 ✓ matches:', JSON.stringify(g.matches.slice(0, 40)));

  // 5. grep 正常功能
  const g2 = await h('tool:grep')({}, { pattern: 'console.log', path: REPO });
  if (!g2.matches.includes('app.js')) { console.error('FAIL: grep 正常搜索失效'); process.exit(1); }
  console.log('[5] grep 正常搜索 ✓');

  // 6. glob argv 安全
  const gl = await h('tool:glob')({}, { pattern: '*.js', path: REPO });
  if (!gl.files.some(f => f.endsWith('app.js'))) { console.error('FAIL: glob 失效'); process.exit(1); }
  console.log('[6] glob:', gl.files);

  // 7. applyPatch 在 cwd 执行
  const patch = `--- a/app.js\n+++ b/app.js\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n console.log(a, b);\n`;
  const ap = await h('tool:applyPatch')({}, { patch, cwd: REPO });
  const after = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');
  if (!after.includes('const b = 3')) { console.error('FAIL: applyPatch 未生效', JSON.stringify(ap)); process.exit(1); }
  console.log('[7] applyPatch(cwd) 生效 ✓');

  // 8. gitAdd + gitCommit（message 含引号与 $()，不得注入）
  await h('tool:gitAdd')({}, { cwd: REPO, files: 'app.js new.txt' });
  const cm = await h('tool:gitCommit')({}, { cwd: REPO, message: 'fix: "quoted" $(touch /tmp/mjcoder-pwned-marker)' });
  const log = await h('tool:gitLog')({}, { cwd: REPO, count: 1 });
  if (fs.existsSync(PWNED)) { console.error('FAIL: commit message 注入成功！'); process.exit(1); }
  if (!log.stdout.includes('quoted')) { console.error('FAIL: commit 未生效', JSON.stringify(cm)); process.exit(1); }
  console.log('[8] gitAdd/commit 含特殊字符安全 ✓ log:', log.stdout.trim());

  // 9. 清理后 gitStatus 干净
  const st2 = await h('tool:gitStatus')({}, { cwd: REPO });
  if (st2.stdout.trim() !== '') { console.error('FAIL: 提交后工作区应干净', st2.stdout); process.exit(1); }
  console.log('[9] 提交后工作区干净 ✓');

  // 10. 沙箱 fail-safe（P0-B / TC-QA-002）：不传 sandboxPolicy 不得落到 full-access
  if (process.platform === 'darwin') {
    const noPolicy = await h('tool:shell')({}, { command: 'echo hi', cwd: REPO });
    if (noPolicy.sandboxed !== true) { console.error('FAIL: 未传 sandboxPolicy 时应默认沙箱执行（有 cwd → workspace-write），实测为 full-access 直跑', JSON.stringify(noPolicy)); process.exit(1); }
    console.log('[10] 未传 sandboxPolicy → 默认 workspace-write 沙箱执行 ✓');

    // 11. 显式 full-access 才直跑（opt-in，fail-safe 不误伤显式授权）
    const explicit = await h('tool:shell')({}, { command: 'echo hi', cwd: REPO, sandboxPolicy: 'full-access' });
    if (explicit.sandboxed) { console.error('FAIL: 显式 full-access 不应被沙箱包裹'); process.exit(1); }
    console.log('[11] 显式 full-access 直跑（仅 opt-in）✓');

    // 12. 无 cwd（PM-L1 / TC-QA-003）：默认 read-only —— 写入必须被拒绝
    const roMarker = '/tmp/mjcoder-ro-marker';
    fs.rmSync(roMarker, { force: true });
    const noCwd = await h('tool:shell')({}, { command: `touch ${roMarker}` });
    if (noCwd.sandboxed !== true || fs.existsSync(roMarker)) {
      console.error('FAIL: 无 cwd 时应默认 read-only 沙箱并拒绝写入', JSON.stringify(noCwd));
      process.exit(1);
    }
    console.log('[12] 无 cwd → 默认 read-only，写入被拒绝 ✓');
  } else {
    console.log('[10-12] 非 darwin 平台跳过沙箱执行断言（跨平台兜底为 P0-F 范围）');
  }

  // 13. 本地审计落盘（P0-C / TC-QA-004）：无服务端令牌时 shell 执行必须留痕
  const auditFile = '/tmp/mjcode-test/audit-log.jsonl';
  fs.rmSync(auditFile, { force: true });
  fs.rmSync(`${auditFile}.1`, { force: true });
  await h('tool:shell')({}, { command: 'echo audit-me', cwd: REPO });
  let auditOk = false;
  let auditDetail = '';
  try {
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    auditDetail = `${last.action}/${last.mode}/${last.approval_result}`;
    auditOk = last.action === 'shell' && last.mode === 'local' && String(last.target).includes('echo audit-me') && !!last.ts;
  } catch (e) { /* 文件不存在或解析失败 → 断言失败 */ }
  if (!auditOk) { console.error('FAIL: 无令牌时本地审计未落盘 userData/audit-log.jsonl', auditDetail); process.exit(1); }
  console.log('[13] 本地审计落盘 audit-log.jsonl ✓', auditDetail);

  // 清理
  fs.rmSync(REPO, { recursive: true, force: true });
  console.log('PASS: cwd 贯通 / 注入回归 / applyPatch / git 全套 / 项目探测 全部通过');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });

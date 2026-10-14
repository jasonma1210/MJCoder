// 第四阶段（发布基建）门禁：P1-N 更新链路默认值 + 版本规范 + CI 制品纪律 + 回滚 Runbook
// 静态断言为主（electron-updater 仅打包态可用，无法在 node 直测）；同时锁死
// 「autoUpdater 作用域」这个曾让手动检查链路从未工作的 bug 不复发。
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const DESKTOP = path.join(ROOT, 'desktop');
const read = (p) => fs.readFileSync(p, 'utf8');

const mainSrc = read(path.join(DESKTOP, 'main/main.js'));
const settings = read(path.join(DESKTOP, 'renderer/src/components/SettingsModal.jsx'));
const ci = read(path.join(ROOT, '.github/workflows/ci.yml'));
const pkg = JSON.parse(read(path.join(DESKTOP, 'package.json')));
const serverPkg = JSON.parse(read(path.join(ROOT, 'server/package.json')));
const rendererPkg = JSON.parse(read(path.join(DESKTOP, 'renderer/package.json')));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

check('autoUpdater 为模块作用域声明（修复手动检查 ReferenceError）', () => {
  assert.match(mainSrc, /^let autoUpdater = null;$/m, 'autoUpdater 未在模块作用域声明');
  assert.ok(!/const \{ autoUpdater \} = require\('electron-updater'\)/.test(mainSrc),
    'autoUpdater 又被收回函数作用域：IPC handler 会抛 ReferenceError');
});

check('initUpdater 返回实例且 IPC handler 使用返回值', () => {
  assert.match(mainSrc, /function initUpdater\(\) \{[\s\S]*?return autoUpdater;/);
  assert.match(mainSrc, /const up = initUpdater\(\);\s*\n\s*if \(!up\)/,
    'IPC handler 未使用 initUpdater 返回值（再次引用裸 autoUpdater 会炸）');
});

check('启动延迟 10s 自动检查（保持手动下载）', () => {
  assert.match(mainSrc, /const UPDATE_CHECK_DELAY_MS = 10 \* 1000;/);
  assert.match(mainSrc, /function scheduleAutoUpdateCheck\(\) \{[\s\S]*?if \(!app\.isPackaged\) return;/);
  assert.match(mainSrc, /scheduleAutoUpdateCheck\(\);/, 'whenReady 未接线延迟检查');
  assert.match(mainSrc, /autoDownload = false/, 'autoDownload 必须保持 false：下载由用户确认');
  assert.match(mainSrc, /autoUpdateChecked/, '缺少自动检查去重标志');
});

check('检查失败附手动下载降级链接（build.publish 推导）', () => {
  assert.match(mainSrc, /function resolveManualDownloadUrl\(\)/);
  assert.match(mainSrc, /github\.com\/\$\{pub\.owner\}\/\$\{pub\.repo\}\/releases/,
    '手动下载链接未由 publish owner/repo 推导');
  assert.match(mainSrc, /send\('error', \{ message: err\.message, downloadUrl: MANUAL_DOWNLOAD_URL \}\)/);
  assert.match(mainSrc, /send\('available', \{ version: info\.version, downloadUrl: MANUAL_DOWNLOAD_URL \}\)/);
  assert.match(mainSrc, /return \{ ok: false, error: err\.message, downloadUrl: MANUAL_DOWNLOAD_URL \};/,
    '手动检查失败未带回 downloadUrl');
});

check('更新通道支持 beta 灰度（MJ_UPDATE_CHANNEL）', () => {
  assert.match(mainSrc, /const UPDATE_CHANNEL = process\.env\.MJ_UPDATE_CHANNEL \|\| 'latest';/);
  assert.match(mainSrc, /autoUpdater\.channel = UPDATE_CHANNEL;/);
  assert.equal(pkg.build.publish.channel, 'latest', 'publish.channel 应为 latest');
});

check('设置页渲染手动下载链接（error/available 态）', () => {
  assert.match(settings, /updateDownloadUrl/, '设置页无 downloadUrl 状态');
  assert.match(settings, /手动下载最新版本/, '未渲染手动下载入口');
  assert.match(settings, /setUpdateDownloadUrl\(r\.downloadUrl/, '手动检查失败未降级到下载链接');
  assert.match(settings, /d\.status === 'error' \|\| d\.status === 'available'/,
    'downloadUrl 仅在 error/available 态展示');
});

check('三包版本一致（desktop/server/renderer）', () => {
  assert.equal(pkg.version, serverPkg.version, `server ${serverPkg.version} ≠ desktop ${pkg.version}`);
  assert.equal(pkg.version, rendererPkg.version, `renderer ${rendererPkg.version} ≠ desktop ${pkg.version}`);
});

check('CHANGELOG 存在且含当前版本段', () => {
  const cl = read(path.join(ROOT, 'CHANGELOG.md'));
  assert.match(cl, /## \[1\.0\.0\] - \d{4}-\d{2}-\d{2}/, 'CHANGELOG 缺少当前版本段（日期格式 YYYY-MM-DD）');
  assert.match(cl, /Keep a Changelog/, 'CHANGELOG 未声明格式基线');
});

check('CI 制品纪律（P0-G 回归：tag 触发 + matrix + commit 绑定 + 发布开关）', () => {
  assert.match(ci, /tags: \['v\*'\]/, 'CI 未配置 tag 触发');
  assert.match(ci, /runs-on: \$\{\{ matrix\.os \}\}/, 'release job 未用 matrix 三平台');
  assert.match(ci, /MJCode-\$\{\{ matrix\.os \}\}-\$\{\{ github\.sha \}\}/, '制品名未绑定 commit sha');
  assert.match(ci, /--publish \$\{\{ vars\.PUBLISH_RELEASE/, '缺少受控的发布开关');
  assert.match(ci, /Sync version from tag/, 'release job 未从 tag 同步版本');
});

check('回滚 Runbook 就位', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'docs/发布回滚Runbook.md')), '缺少 docs/发布回滚Runbook.md');
  const rb = read(path.join(ROOT, 'docs/发布回滚Runbook.md'));
  assert.match(rb, /回滚步骤/);
  assert.match(rb, /latest\.yml/, 'Runbook 未说明 latest.yml 是更新源真值');
  assert.match(rb, /演练记录/);
});

console.log(`\nPASS：${pass}/${total} 项通过`);
process.exit(pass === total ? 0 : 1);

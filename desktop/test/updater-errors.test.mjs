// T2-7 门禁：更新失败可诊断文案（main/updater/index.js classifyUpdateError）
// 断言：五类失败模式各有 kind + 可行动 hint；校验类错误必须显式警告（绝不静默）；
//       未知错误指向诊断包（T2-5/T2-6 闭环）。
// P0-3：追加 updater:download IPC 门禁——补上更新回路缺失的一环（此前全仓零调用
//       downloadUpdate，用户看到 available 后没有任何按钮触发下载）。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// updater 模块顶层 require('electron')——注入 stub 后再加载。
// ipcMain.handle 捕获注册表（供下方 updater:download 门禁取 handler）；
// app.isPackaged 可变（同一 stub 上翻打包态，不重建模块）。
const handlers = new Map();
const mainRequire = createRequire(path.join(DESKTOP, 'main', 'noop.js'));
const electronAppStub = { isPackaged: false, getPath: () => '/tmp' };
require.cache[mainRequire.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true,
  exports: { app: electronAppStub, ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) } },
};

const { classifyUpdateError, init } = require(path.join(DESKTOP, 'main/updater/index.js'));

let pass = 0, total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

check('断网类 → network：明确不影响当前版本', () => {
  const r = classifyUpdateError({ message: 'Cannot download update: getaddrinfo ENOTFOUND github.com' });
  assert.equal(r.kind, 'network');
  assert.match(r.hint, /检查网络/);
  assert.match(r.hint, /不影响当前版本/);
});

check('校验失败类 → integrity：绝不静默，指向手动下载官方包', () => {
  for (const msg of [
    'SHA512 digest mismatch for file: app.zip',
    'Update signature verification failed',
    'invalid blockmap',
  ]) {
    const r = classifyUpdateError({ message: msg });
    assert.equal(r.kind, 'integrity', `${msg} 应归 integrity`);
    assert.match(r.hint, /校验失败/);
    assert.match(r.hint, /手动下载/);
  }
});

check('更新源缺失类 → notfound', () => {
  const r = classifyUpdateError({ message: '404 Not Found Cannot find update for channel latest' });
  assert.equal(r.kind, 'notfound');
  assert.match(r.hint, /更新源/);
});

check('安装前置失败类 → install', () => {
  const r = classifyUpdateError({ message: 'EPERM: operation not permitted, Installer volume busy' });
  assert.equal(r.kind, 'install');
  assert.match(r.hint, /退出应用后重试|覆盖安装/);
});

check('未知类 → unknown：指向诊断包导出（反馈闭环）', () => {
  const r = classifyUpdateError({ message: 'something exotic happened' });
  assert.equal(r.kind, 'unknown');
  assert.match(r.hint, /诊断包/);
});

check('所有分类都带非空 hint（不静默原则）', () => {
  for (const msg of ['ENOTFOUND x', 'digest fail', '404', 'EPERM', 'weird']) {
    const r = classifyUpdateError({ message: msg });
    assert.ok(r.hint && r.kind, `分类缺失：${msg}`);
  }
});

// ── P0-3：updater:download IPC（handler 行为，注入 electron-updater stub）──
let downloadCalls = 0;
let downloadShouldThrow = null;
require.cache[mainRequire.resolve('electron-updater')] = {
  id: 'electron-updater', filename: 'electron-updater', loaded: true,
  exports: {
    autoUpdater: {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      channel: 'latest',
      on: () => {},
      quitAndInstall: () => {},
      downloadUpdate: async () => {
        downloadCalls += 1;
        if (downloadShouldThrow) throw downloadShouldThrow;
      },
    },
  },
};

init({ getMainWindow: () => null });

(async () => {
  const downloadHandler = handlers.get('updater:download');
  total++;
  if (typeof downloadHandler === 'function') { console.log('[PASS] updater:download IPC 已注册'); pass++; }
  else { console.error('[FAIL] updater:download IPC 未注册'); process.exitCode = 1; }

  // 1. 未打包态：明确错误，不触发下载（不假装在下载）
  const r1 = await downloadHandler();
  total++;
  if (r1.ok === false && /仅打包后可下载更新/.test(r1.error) && downloadCalls === 0) {
    console.log('[PASS] 未打包态下载：明确拒绝且不触发 downloadUpdate'); pass++;
  } else { console.error(`[FAIL] 未打包态下载 — ${JSON.stringify(r1)}`); process.exitCode = 1; }

  // 2. 打包态：调起 downloadUpdate（autoDownload=false 下这是唯一下载入口）
  electronAppStub.isPackaged = true;
  const r2 = await downloadHandler();
  total++;
  if (r2.ok === true && downloadCalls === 1) {
    console.log('[PASS] 打包态下载：调起 autoUpdater.downloadUpdate()'); pass++;
  } else { console.error(`[FAIL] 打包态下载 — ${JSON.stringify(r2)} calls=${downloadCalls}`); process.exitCode = 1; }

  // 3. 下载失败（校验类）：带回 kind/hint/downloadUrl，绝不静默
  downloadShouldThrow = new Error('SHA512 digest mismatch for file: app.zip');
  const r3 = await downloadHandler();
  total++;
  if (r3.ok === false && r3.kind === 'integrity' && /手动下载/.test(r3.hint) && r3.downloadUrl) {
    console.log('[PASS] 下载失败归类 integrity 并带手动下载兜底链接'); pass++;
  } else { console.error(`[FAIL] 下载失败归类 — ${JSON.stringify(r3)}`); process.exitCode = 1; }

  // 4. autoDownload 必须保持 false（下载只能由用户显式触发）
  const updaterSrc = require('fs').readFileSync(path.join(DESKTOP, 'main/updater/index.js'), 'utf8');
  total++;
  if (/autoUpdater\.autoDownload = false/.test(updaterSrc)) {
    console.log('[PASS] autoDownload 保持 false：下载由用户显式触发'); pass++;
  } else { console.error('[FAIL] autoDownload 被改动：下载将不再需要用户确认'); process.exitCode = 1; }

  console.log(`\nupdater-errors: ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})();

// T2-7 门禁：更新失败可诊断文案（main/updater/index.js classifyUpdateError）
// 断言：五类失败模式各有 kind + 可行动 hint；校验类错误必须显式警告（绝不静默）；
//       未知错误指向诊断包（T2-5/T2-6 闭环）。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// updater 模块顶层 require('electron')——注入 stub 后再加载
const mainRequire = createRequire(path.join(DESKTOP, 'main', 'noop.js'));
require.cache[mainRequire.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true,
  exports: { app: { isPackaged: false, getPath: () => '/tmp' }, ipcMain: { handle: () => {} } },
};

const { classifyUpdateError } = require(path.join(DESKTOP, 'main/updater/index.js'));

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

console.log(`\nupdater-errors: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);

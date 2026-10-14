// 消息 meta 行与运行结束信息条渲染测试（真机复盘：结果出来了但「结束的信息」全缺）
// 覆盖：双轨字段（snake_case 在线 / camelCase 本地库）meta 渲染、
//       中间消息（有 token 无模型名）meta、空 meta 不渲染、RunFooter 四态。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(DESKTOP, 'renderer/src');
const esbuild = require(path.join(DESKTOP, 'renderer/node_modules/esbuild'));

let pass = 0, total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// ── 浏览器 API 桩（与 render-smoke 一致，ChatArea 模块顶层求值所需）──
const noop = () => {};
const define = (key, value) => {
  try { Object.defineProperty(globalThis, key, { value, writable: true, configurable: true }); }
  catch { /* 不可覆盖则保持原值 */ }
};
const storage = { getItem: () => null, setItem: noop, removeItem: noop, clear: noop };
define('window', {
  addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
  location: { href: 'http://localhost/' }, mjcode: undefined,
  localStorage: storage, sessionStorage: storage,
  getComputedStyle: () => ({}), matchMedia: () => ({ matches: false, addListener: noop, addEventListener: noop }),
  requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: noop,
  innerWidth: 1280, innerHeight: 800,
});
define('document', {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop, addEventListener: noop }),
  addEventListener: noop, removeEventListener: noop,
  body: { appendChild: noop, removeChild: noop }, documentElement: { style: {} }, head: { appendChild: noop },
});
define('localStorage', storage);
define('sessionStorage', storage);
define('navigator', { userAgent: 'node', platform: 'darwin', clipboard: { writeText: async () => {} } });
define('CustomEvent', class { constructor(t, o) { this.type = t; Object.assign(this, o); } });
define('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { createRequire: makeRequire } = await import('node:module');
const rendererRequire = makeRequire(path.join(DESKTOP, 'renderer/package.json'));
const result = esbuild.buildSync({
  entryPoints: [path.join(SRC, 'components/ChatArea.jsx')],
  bundle: true,
  external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
  define: { 'process.env.NODE_ENV': '"production"' },
  format: 'cjs', platform: 'browser', jsx: 'automatic',
  loader: { '.jsx': 'jsx', '.js': 'jsx', '.mjs': 'jsx', '.png': 'dataurl', '.svg': 'dataurl', '.css': 'empty' },
  write: false, logLevel: 'silent',
});
const moduleObj = { exports: {} };
// eslint-disable-next-line no-new-func
new Function('require', 'module', 'exports', '__filename', '__dirname', result.outputFiles[0].text)(
  rendererRequire, moduleObj, moduleObj.exports, path.join(SRC, 'components/ChatArea.jsx'), SRC,
);
const { renderMessages, RunFooter } = moduleObj.exports;
const React = rendererRequire('react');
const { renderToStaticMarkup } = rendererRequire('react-dom/server');
const htmlOf = (fn) => renderToStaticMarkup(React.createElement('div', null, typeof fn === 'function' ? fn() : fn));

const T = 1791966897626; // 2026-10-14 16:34 CST

check('meta：最终回复（snake_case，在线字段）渲染 共消耗/模型/时间', () => {
  const html = htmlOf(() => renderMessages([
    { role: 'assistant', content: '结论', model_name: 'mimo-v2.6-flash', tokens_input: 626627, tokens_output: 10946, created_at: T },
  ]));
  assert.ok(html.includes('共消耗 637,573 tokens'), `缺共消耗：${html.slice(0, 200)}`);
  assert.ok(html.includes('mimo-v2.6-flash'), '缺模型名');
  assert.ok(html.includes(':') && /\d{1,2}:\d{2}/.test(html), '缺时间');
});

check('meta：本地库回读（camelCase 字段）同样渲染', () => {
  const html = htmlOf(() => renderMessages([
    { role: 'assistant', content: '结论', modelName: 'mimo-v2.6-flash', tokensInput: 100, tokensOutput: 20, createdAt: T },
  ]));
  assert.ok(html.includes('共消耗 120 tokens'), '缺共消耗');
  assert.ok(html.includes('mimo-v2.6-flash'), '缺模型名');
});

check('meta：中间消息（有 token 无模型名）也展示消耗（条件放宽回归）', () => {
  const html = htmlOf(() => renderMessages([
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'shell', arguments: '{}' } }], tokens_input: 17546, tokens_output: 205, created_at: T },
  ]));
  assert.ok(html.includes('共消耗 17,751 tokens'), '中间消息消耗应可见');
});

check('meta：无任何元信息的消息不渲染空行', () => {
  const html = htmlOf(() => renderMessages([{ role: 'assistant', content: '裸消息' }]));
  assert.ok(!html.includes('共消耗'), '不应出现空 meta');
});

check('RunFooter：正常结束态展示 状态/耗时/共消耗/模型/时间', () => {
  const html = htmlOf(React.createElement(RunFooter, {
    summary: { status: 'done', durationMs: 660000, tokensIn: 626627, tokensOut: 10946, model: 'mimo-v2.6-flash', endedAt: T },
  }));
  assert.ok(html.includes('运行结束'), '缺状态');
  assert.ok(html.includes('耗时 11m0s'), `缺耗时：${html.slice(0, 300)}`);
  assert.ok(html.includes('共消耗 637,573 tokens'), '缺共消耗');
  assert.ok(html.includes('mimo-v2.6-flash'), '缺模型');
});

check('RunFooter：预算暂停态提示断点可恢复', () => {
  const html = htmlOf(React.createElement(RunFooter, {
    summary: { status: 'suspended', durationMs: 65000, tokensIn: 1, tokensOut: 1, model: 'm', endedAt: T },
  }));
  assert.ok(html.includes('任务暂停') && html.includes('「继续」'), '缺暂停恢复提示');
});

check('RunFooter：summary 为空不渲染内容', () => {
  const html = htmlOf(React.createElement(RunFooter, { summary: null }));
  assert.ok(!html.includes('运行结束') && !html.includes('共消耗'), '空 summary 不应渲染任何内容');
});

console.log(`\nPASS：${pass}/${total} 项通过`);
process.exit(pass === total ? 0 : 1);

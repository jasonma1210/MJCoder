// 渲染层冒烟：不启动 Electron，直接 import 每个组件模块做静态求值
//
// 背景：连续四次白屏（onModeChange / planMode / IconAlert / modeMsg），
// 全部是「import 时或首帧渲染时抛 ReferenceError」这一类。
// 纯静态门禁（undef-ident / props-contract）能覆盖大部分，但：
//   - 跨文件 props 契约超出静态分析范围
//   - 模块顶层代码（常量初始化、解构默认值）出错静态分析未必能抓到
//   - 循环 import、副作用顺序问题静态分析完全看不见
//
// 做法：用 esbuild 把每个组件打包成 CJS，在 Node 里 require 一遍。
// 模块顶层若抛错（ReferenceError / TDZ / 循环依赖），这里立刻炸出来。
// 这不是完整渲染测试（不跑 React 渲染），只验「模块能加载」这一层。
//
// 用法：node test/smoke-load.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(DESKTOP, 'renderer/src');
const esbuild = require(path.join(DESKTOP, 'renderer/node_modules/esbuild'));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

/** 收集待加载的渲染层模块 */
function listModules() {
  const out = [];
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if ((e.name.endsWith('.jsx') || e.name.endsWith('.js')) && !e.name.includes('deprecated')) {
        out.push(rel);
      }
    }
  };
  walk(SRC, '');
  return out.sort();
}

// 浏览器 API 桩：模块顶层可能访问 window/document/localStorage
// 注意：Node 18+ 起 navigator 是只读 getter，必须用 defineProperty 覆盖
const noop = () => {};
const define = (key, value) => {
  try { Object.defineProperty(globalThis, key, { value, writable: true, configurable: true }); }
  catch { /* 不可覆盖则保持原值 */ }
};
const stubEl = () => ({
  appendChild: noop, removeChild: noop, setAttribute: noop, removeAttribute: noop,
  style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  addEventListener: noop, removeEventListener: noop, focus: noop, blur: noop,
  children: [], childNodes: [], innerHTML: '', textContent: '', value: '',
  getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 20, right: 100, bottom: 20 }),
});
const storage = {
  getItem: () => null, setItem: noop, removeItem: noop, clear: noop,
};
define('window', {
  addEventListener: noop, removeEventListener: noop,
  dispatchEvent: noop, location: { href: 'http://localhost/' },
  mjcode: undefined, localStorage: storage, sessionStorage: storage,
  getComputedStyle: () => ({}), matchMedia: () => ({ matches: false, addListener: noop }),
  requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: noop,
});
define('document', {
  getElementById: () => stubEl(),
  querySelector: () => null, querySelectorAll: () => [],
  createElement: stubEl, createTextNode: () => ({}),
  addEventListener: noop, removeEventListener: noop,
  body: stubEl(), documentElement: stubEl(),
});
define('localStorage', storage);
define('sessionStorage', storage);
define('navigator', { userAgent: 'node', platform: 'darwin' });
define('CustomEvent', class CustomEvent { constructor(t, o) { this.type = t; Object.assign(this, o); } });
define('matchMedia', () => ({ matches: false, addListener: noop, addEventListener: noop }));
define('requestAnimationFrame', (cb) => setTimeout(cb, 0));
define('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
define('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });

/** 用 esbuild 把 JSX 打成 CJS，返回可 require 的代码 */
function compile(rel) {
  const abs = path.join(SRC, rel);
  const result = esbuild.buildSync({
    entryPoints: [abs],
    bundle: false,                 // 不打包，保留 import 以便真正解析依赖
    format: 'cjs',
    platform: 'neutral',
    jsx: 'automatic',
    loader: { '.jsx': 'jsx', '.tsx': 'tsx', '.js': 'jsx', '.mjs': 'jsx' },
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

// 依赖解析根：渲染层（react 等装在这里）
const { createRequire: makeRequire } = await import('node:module');
const rendererRequire = makeRequire(path.join(DESKTOP, 'renderer/package.json'));

/** 把 CJS 源码包成可执行函数，注入 require（相对路径解析回真实 .jsx） */
function makeLoader(rel, src) {
  const relDir = path.dirname(path.join(SRC, rel));
  const moduleObj = { exports: {} };
  const localRequire = (spec) => {
    // 裸模块名（react / react-dom 等）从 renderer/node_modules 解析，
    // 因为依赖装在渲染层而非桌面根目录
    if (!spec.startsWith('.')) return rendererRequire(spec);
    let target = path.resolve(relDir, spec);
    // 补全扩展名：import './Foo' → './Foo.jsx'
    if (!path.extname(target)) {
      for (const ext of ['.jsx', '.js', '.mjs']) {
        if (fs.existsSync(target + ext)) { target += ext; break; }
      }
    } else if (!fs.existsSync(target) && fs.existsSync(target + '.jsx')) {
      target += '.jsx';
    }
    if (path.extname(target) === '.mjs') target = target.replace(/\.mjs$/, '.jsx');
    const tRel = path.relative(SRC, target).split(path.sep).join('/');
    if (!loaded.has(tRel)) {
      loaded.set(tRel, {});
      try { loadModule(tRel); } catch { /* 已在调用侧记录 */ }
    }
    return loaded.get(tRel);
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('require', 'module', 'exports', '__filename', '__dirname', src);
  fn(localRequire, moduleObj, moduleObj.exports, path.join(SRC, rel), path.join(SRC, relDir));
  loaded.set(rel, moduleObj.exports);
  return moduleObj.exports;
}

const loaded = new Map();

function loadModule(rel) {
  const src = compile(rel);
  return makeLoader(rel, src);
}

const files = listModules();
// main.jsx 是入口，模块顶层会真的执行 createRoot(...).render(...)
// 在 Node 里没有真实 DOM，必然抛「Target container is not a DOM element」。
// 这不属于冒烟要覆盖的范畴 —— 改为验证它的依赖树能被完整加载。
check('冒烟：main.jsx 的依赖树可加载', () => {
  const src = compile('main.jsx');
  // 抽出 main.jsx 的 import 目标，逐个加载
  const imports = [...src.matchAll(/require\("(\.[^"]+)"\)/g)].map((m) => m[1]);
  // 样式文件不是 JS 模块，不参与加载验证
  const jsImports = imports.filter((s) => !/\.(css|scss|less|png|svg|json)$/.test(s));
  assert.ok(jsImports.length > 0, 'main.jsx 未发现相对 JS import');
  const failures = [];
  for (const spec of jsImports) {
    const rel = spec.replace(/^\.\//, '');
    const resolved = [rel, `${rel}.jsx`, `${rel}/index.jsx`].find((r) => fs.existsSync(path.join(SRC, r)));
    if (!resolved) { failures.push(`${spec} → 文件不存在`); continue; }
    try { loadModule(resolved); }
    catch (e) { failures.push(`${resolved} → ${e.message.split('\n')[0]}`); }
  }
  assert.equal(failures.length, 0, `\n       ${failures.join('\n       ')}`);
  console.log(`       main.jsx 依赖 ${jsImports.length} 个 JS 模块（另有 ${imports.length - jsImports.length} 个样式），均加载成功`);
});

check('冒烟：每个组件模块可独立加载', () => {
  const failures = [];
  for (const rel of files) {
    if (rel === 'main.jsx') continue;
    try {
      loaded.delete(rel);
      loadModule(rel);
    } catch (e) {
      failures.push(`${rel} → ${e.message.split('\n')[0]}`);
    }
  }
  assert.equal(failures.length, 0, `\n       ${failures.join('\n       ')}`);
});

console.log(`\nPASS：${pass}/${total} 项通过`);
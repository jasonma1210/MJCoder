// X23 回归门禁：preload 桥面与渲染层调用面的静态双向校验。
//
// 背景：`window.mjcode` 的类型是 `Record<string, (...args) => unknown>`，方法名拼错
// （`localThread` vs `localThreads`）能通过 tsc，运行时被 lib/ipc.js 降级成
// capabilityUnavailable —— 代码缺陷与「平台不支持」在运行时长得一模一样。
//
// 完整修法是给桥面生成精确 TS 接口，但前置条件是清掉 6 个 @ts-nocheck 文件
// （其中 3 个是核心对话链路），属独立工作。在那之前，用**静态比对**兜住最致命的一类：
// 渲染层调用了 preload 没暴露的方法（拼错 / 漏暴露 → 功能静默不可用）。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PRELOAD = path.join(DESKTOP, 'main/preload.js');
const SRC = path.join(DESKTOP, 'renderer/src');

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// ── 1) 从 preload 源码提取暴露的方法名（exposeInMainWorld 对象字面量的顶层键）──
const preloadSrc = fs.readFileSync(PRELOAD, 'utf8');
const bridgeNames = new Set();
{
  const start = preloadSrc.indexOf("exposeInMainWorld('mjcode'");
  if (start < 0) throw new Error('preload 中找不到 exposeInMainWorld(\'mjcode\')');
  for (const line of preloadSrc.slice(start).split('\n')) {
    const m = line.match(/^\s{2}([A-Za-z_$][\w$]*)\s*:/);
    if (m) bridgeNames.add(m[1]);
    if (/^\}\);/.test(line)) break;
  }
}

// ── 2) 扫描渲染层对 window.mjcode 的调用 ──
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full, out); }
    else if (/\.(jsx?|tsx?)$/.test(e.name)) out.push(full);
  }
  return out;
}
// 注释里会出现 `window.mjcode.marketXxx` 这类占位写法（lib/market.js:1），必须剥掉再扫，
// 否则门禁会被文档字符串误伤。
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (_m, p1) => p1);
}

const used = new Map(); // method -> [文件:行]
for (const file of walk(SRC)) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  src.split('\n').forEach((line, i) => {
    // mjcode.xxx(  /  mjcode?.xxx?.(  /  mjcode['xxx'](
    const re = /mjcode\??\.([A-Za-z_$][\w$]*)|mjcode\??\[['"]([A-Za-z_$][\w$]*)['"]\]/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const name = m[1] || m[2];
      if (!name) continue;
      if (!used.has(name)) used.set(name, []);
      used.get(name).push(`${path.relative(SRC, file)}:${i + 1}`);
    }
  });
}

check('preload 桥面非空（提取逻辑没跑偏）', () => {
  if (bridgeNames.size < 50) throw new Error(`只提取到 ${bridgeNames.size} 个方法，提取规则可能已失效`);
});

check('渲染层调用的每个桥方法都真实存在于 preload', () => {
  const missing = [...used.entries()].filter(([name]) => !bridgeNames.has(name));
  if (missing.length) {
    const detail = missing.map(([n, where]) => `${n}（${where[0]}）`).join('; ');
    throw new Error(`调用了未暴露的方法：${detail}`);
  }
});

check('桥面里的死方法占比受控（暴露但从未被调用）', () => {
  const dead = [...bridgeNames].filter((n) => !used.has(n));
  // 当前实测：约 40 个（diag:preview 这类历史遗留）。占比超过 40% 说明要么扫描逻辑失效，
  // 要么有人在往 bridge 上堆没人用的方法。
  const ratio = dead.length / bridgeNames.size;
  if (ratio > 0.4) throw new Error(`死方法 ${dead.length}/${bridgeNames.size} = ${(ratio * 100).toFixed(0)}%，超过 40% 上限`);
});

console.log(`\nbridge-parity: ${pass}/${total} 通过（桥面 ${bridgeNames.size} 个方法，渲染层引用 ${used.size} 个）`);
process.exit(pass === total ? 0 : 1);

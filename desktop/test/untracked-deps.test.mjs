// X24 回归门禁：运行时依赖必须入库（「干净 clone 能跑」才算通过）。
//
// 背景：2026-10-17 提交时发现 `main/scheduledOutput.js` **从未被 git 跟踪**——
// 本机 `require` 得到（文件在磁盘上），CI 检出后 `require` 不到，应用起不来。
// 而所有本地门禁（119 套测试、tsc、vite build）都只读磁盘，**测不出「文件不在库里」**。
//
// 这是同一个根因的第三次发作：
//   · X1  ecosystem/skills 的 100 个 SKILL.md 被 .gitignore 排除 → 打包产物技能为空；
//   · X7  7 个测试用例被排除 → 外部 clone 拿不到断言；
//   · X24 20 个运行时文件（SplashScreen/appState/color/autoLaunch/childRegistry…）未入库。
//
// 共同点：**「我这台能跑」≠「clone 下来能跑」**。本用例把这句话变成机器校验：
// 扫描 main / agent-core / renderer 的静态相对引用，逐个检查目标文件
//   ① 在磁盘上存在（缺失 = 断链）  ② 被 git 跟踪（未跟踪 = CI/外部 clone 断链）。
//
// 已知不做的事：
//   · 不解析动态路径（`require(path.join(__dirname, x))`）——静态分析拿不到值，跳过；
//   · 不解析 CSS 的 `@import`（构建期由 PostCSS 处理，缺失会由 vite build 直接报错）。
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.dirname(DESKTOP);

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// ── 1) 取仓库已跟踪文件集合（一次 git 调用，避免 O(n) 次 spawn）──
function loadTracked() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return new Set(out.split('\0').filter(Boolean).map((p) => path.join(REPO, p)));
  } catch (e) {
    return null; // 非 git 环境（源码 tarball）：门禁无法判定，跳过而非误报
  }
}
const tracked = loadTracked();

// ── 2) 遍历源码文件 ──
const SCAN_ROOTS = [
  path.join(DESKTOP, 'main'),
  path.join(DESKTOP, 'agent-core'),
  path.join(DESKTOP, 'renderer/src'),
];
const CODE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
// 全量枚举用的后缀：含 JSON（i18n 语言包），静态引用看不见它们——
// i18n 走 `import.meta.glob('.../locales/*/*.json')`，glob 在编译期展开成模块表，
// 源码里没有任何 import 语句；未入库的 JSON 在干净 clone 里**静默消失**（回落 key）
// 而不是构建失败，所以必须靠全量枚举兜住。
const ASSET_EXT = new Set([...CODE_EXT, '.json']);
const RESOLVE_EXT = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.css',
  '/index.js', '/index.jsx', '/index.ts', '/index.tsx'];

function walk(dir, out = [], extSet = CODE_EXT) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, extSet);
    else if (extSet.has(path.extname(e.name))) out.push(full);
  }
  return out;
}

// 提取静态相对引用：require('x') / from 'x' / import 'x' / import('x')
const SPEC_RE = /(?:require\(\s*|from\s+|import\s*\(\s*|import\s+)(['"])(\.[^'"]+)\1/g;

const missing = [];   // 磁盘上不存在 → 断链
const untracked = []; // 存在但未入库 → clone 后断链
let specCount = 0;

for (const file of SCAN_ROOTS.flatMap((r) => walk(r))) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(SPEC_RE)) {
    const spec = m[2];
    specCount++;
    const base = path.resolve(path.dirname(file), spec);
    let hit = null;
    for (const ext of RESOLVE_EXT) {
      const cand = base + ext;
      try { if (fs.statSync(cand).isFile()) { hit = cand; break; } } catch { /* 继续试下一个后缀 */ }
    }
    const rel = path.relative(REPO, file);
    if (!hit) { missing.push(`${rel} → ${spec}`); continue; }
    if (tracked && !tracked.has(hit)) untracked.push(`${rel} → ${spec}`);
  }
}

// ── 3) 全量枚举：三个源码根下的每个源文件都必须在库里 ──
// 这一条与静态引用检查互补：静态分析只能看到写死的 import，
// 而 glob 加载（i18n 语言包）、`extraResources` 打包（ecosystem/）、
// 动态 `require(path.join(...))` 都看不见 —— 它们缺失时是**静默降级**，最难发现。
const allSources = SCAN_ROOTS.flatMap((r) => walk(r, [], ASSET_EXT));
const notTracked = tracked ? allSources.filter((f) => !tracked.has(f)) : [];

// ── 4) 断言 ──
check('扫描到的静态相对引用数量 > 350（防止正则失效后静默全绿）', () => {
  if (specCount < 350) throw new Error(`只扫到 ${specCount} 条静态相对引用，疑似解析退化（2026-10-17 实测 429）`);
});

check('所有静态相对引用的目标文件都存在（无断链）', () => {
  if (missing.length) throw new Error(`${missing.length} 处断链:\n  ${missing.join('\n  ')}`);
});

check('所有静态相对引用的目标文件都已入库（干净 clone 可构建）', () => {
  if (!tracked) { console.log('  ⚠ 跳过：当前目录不是 git 仓库，无法判定入库状态'); return; }
  if (untracked.length) {
    throw new Error(`${untracked.length} 个运行时依赖未入库，CI 检出后会断链:\n  ${untracked.join('\n  ')}\n`
      + '  修法：git add 这些文件（不要加进 .gitignore——它们是运行期必需，不是本地产物）');
  }
});

check('三个源码根下的全部源文件都已入库（含 glob 加载的语言包）', () => {
  if (!tracked) { console.log('  ⚠ 跳过：当前目录不是 git 仓库，无法判定入库状态'); return; }
  if (notTracked.length) {
    const shown = notTracked.slice(0, 30).map((f) => path.relative(REPO, f));
    throw new Error(`${notTracked.length} 个源文件未入库（干净 clone 后缺失/静默降级）:\n  ${shown.join('\n  ')}`
      + (notTracked.length > 30 ? `\n  …另有 ${notTracked.length - 30} 个` : ''));
  }
});

console.log(`\n总计 ${total} · 通过 ${pass} · 源文件 ${allSources.length} · 静态引用 ${specCount}`);

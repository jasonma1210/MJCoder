// T3-2 门禁：i18n 完整性四项断言。
// ① 扫描口径：components/ + App.jsx + main.jsx + i18n/ 注释剥离后零裸中文（复用 scripts/i18n-scan.mjs）
// ② 语言包 key 覆盖：zh-CN 与 en-US 深度 key 集双向一致（en-US 覆盖率 100%，验收核心）
// ③ 组件引用的 t('x.y')/tGlobal('x.y') key 必须真实存在于 zh-CN 包（防漏登记）
// ④ 切换免重启接线：main.jsx 挂 LanguageProvider、SettingsModal 有 setLocale 入口；
//    且 zh/en 同 key 的 {var} 插值参数集一致（防翻译丢参数）
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(DESKTOP, 'renderer', 'src');
const LOCALES_DIR = path.join(SRC, 'i18n', 'locales');

let pass = 0, total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.stack || e.message}`); process.exitCode = 1; }
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const listModules = (locale) => {
  const dir = path.join(LOCALES_DIR, locale);
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json')) out[f.replace(/\.json$/, '')] = readJson(path.join(dir, f));
  }
  return out;
};
const flatKeys = (obj, prefix = '') => {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) keys.push(...flatKeys(v, p));
    else if (typeof v === 'string') keys.push(p);
    else throw new Error(`语言包叶子必须是字符串：${p}`);
  }
  return keys;
};
const varsOf = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

const zh = listModules('zh-CN');
const en = listModules('en-US');

// ── ① 零裸中文扫描 ──
// 口径（2026-10-16 扩展）：renderer/src 全量——constants/hooks/lib 的顶层中文曾绕过
// 旧口径（仅 components+App+main+i18n），导致切英文后设置页仍显示中文（真机反馈）。
// prompt 注入文案与用户输入匹配字面量按行 `i18n-literal` 豁免。
await check('renderer/src 全量注释剥离后零裸中文', () => {
  const targets = [SRC];
  try {
    execFileSync('node', [path.join(DESKTOP, 'scripts', 'i18n-scan.mjs'), ...targets], { stdio: 'pipe' });
  } catch (e) {
    const out = String(e.stdout || '');
    throw new Error(`存在裸中文残留：\n${out.slice(0, 3000)}`);
  }
});

// ── ①b 主进程事件载荷裸中文（A1 棘轮，2026-10-16）──
// 门禁缺口实证：test 原口径只扫 renderer/src，而 main/workerPool.js 五处中文
// 经 tasks:event 直出渲染层原样渲染 ⇒ 英文界面漏中文且门禁结构性失明。
// 棘轮设计（D19）：workerPool.js 活动流已清零 ⇒ 纳入门禁（有残留即失败）；
// main/ 其余载荷字段（实测约 272 行、38 文件）为已知债务 A1b，当前仅报告不计失败——
// 但报告会打印在测试输出里，新增违规会被下次基线更新时发现。
await check('主进程事件载荷零裸中文（workerPool 活动流门禁）', () => {
  const out = String(execFileSync('node', [
    path.join(DESKTOP, 'scripts', 'i18n-scan.mjs'),
    '--ipc-payloads', path.join(DESKTOP, 'main'),
  ], { stdio: 'pipe' }));
  const lines = out.split('\n').filter((l) => /^\S+\.js:\d+:/.test(l));
  // 门禁范围＝活动流（task_activity 的 text 字段）：高频、每次任务必发、渲染层直接展示。
  // error 字段虽经 SubtaskTree:130 可达 UI，但其 key 化需 taskStore 的 error 列承载
  // errorKey（数据模型改动），与 main/ 其余 272 行债务同属 A1b，当前仅报告。
  const workerPoolText = lines.filter((l) => l.includes('workerPool.js') && /\btext\s*:/.test(l));
  if (workerPoolText.length) {
    throw new Error(`workerPool.js 活动流存在裸中文（A1 已清零，禁止回流）：\n${workerPoolText.join('\n')}`);
  }
  const byFile = {};
  for (const l of lines) {
    const f = l.split(':')[0];
    byFile[f] = (byFile[f] || 0) + 1;
  }
  const debt = Object.entries(byFile).sort((a, b) => b[1] - a[1])
    .map(([f, c]) => `${f}: ${c}`).join(', ');
  if (lines.length) {
    console.log(`ℹ main/ 事件载荷裸中文已知债务（A1b，未纳入门禁）：${lines.length} 行 — ${debt}`);
  }
});

// ── ② key 覆盖双向一致 ──
await check('en-US 语言包 key 覆盖率 100%（与 zh-CN 双向一致）', () => {
  const problems = [];
  for (const mod of Object.keys(zh)) {
    if (!en[mod]) { problems.push(`en-US 缺整个模块文件：${mod}.json`); continue; }
    const zk = flatKeys(zh[mod]);
    const ek = new Set(flatKeys(en[mod]));
    for (const k of zk) if (!ek.has(k)) problems.push(`en-US 缺 key：${mod}.${k}`);
  }
  for (const mod of Object.keys(en)) {
    if (!zh[mod]) { problems.push(`zh-CN 缺模块文件：${mod}.json（en 多余）`); continue; }
    const ek = flatKeys(en[mod]);
    const zk = new Set(flatKeys(zh[mod]));
    for (const k of ek) if (!zk.has(k)) problems.push(`zh-CN 缺 key：${mod}.${k}（en 多余）`);
  }
  if (problems.length) throw new Error(problems.slice(0, 40).join('\n'));
});

// ── ③ 引用 key 存在性 ──
await check('组件引用的 i18n key 全部存在于语言包', () => {
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      // i18n/ 是基础设施：源码注释里的 t('x.y') 示例不是真实引用，排除
      if (p === path.join(SRC, 'i18n')) return;
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(jsx?|tsx?)$/.test(f)) files.push(p);
    }
  })(SRC);
  const missing = [];
  const re = /\bt(?:Global)?\(\s*['"]([\w.]+)['"]/g;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(re)) {
      const key = m[1];
      const mod = key.split('.')[0];
      const sub = key.split('.').slice(1).join('.');
      const pack = zh[mod];
      if (!pack) { missing.push(`${key}（${f}：模块 ${mod}.json 不存在）`); continue; }
      let cur = pack;
      for (const seg of sub.split('.')) {
        if (!cur || typeof cur !== 'object') { cur = undefined; break; }
        cur = cur[seg];
      }
      if (typeof cur !== 'string') missing.push(`${key}（${f}）`);
    }
  }
  if (missing.length) throw new Error(`缺失 key：\n${missing.slice(0, 40).join('\n')}`);
});

// ── ④ 接线 + 插值参数一致 ──
await check('切换免重启接线与 {var} 参数一致', () => {
  const mainSrc = fs.readFileSync(path.join(SRC, 'main.jsx'), 'utf8');
  if (!/LanguageProvider/.test(mainSrc)) throw new Error('main.jsx 未挂 LanguageProvider');
  const settings = fs.readFileSync(path.join(SRC, 'components', 'SettingsModal.jsx'), 'utf8');
  if (!/setLocale/.test(settings)) throw new Error('SettingsModal 缺语言切换入口（setLocale）');
  const mism = [];
  for (const mod of Object.keys(zh)) {
    if (!en[mod]) continue;
    const walk = (o, e, pfx) => {
      for (const [k, v] of Object.entries(o)) {
        const p = pfx ? `${pfx}.${k}` : k;
        const ev = e[k];
        if (v && typeof v === 'object') { if (ev && typeof ev === 'object') walk(v, ev, p); continue; }
        if (typeof v === 'string' && typeof ev === 'string' && varsOf(v) !== varsOf(ev)) {
          mism.push(`${mod}.${p}: zh{${varsOf(v)}} vs en{${varsOf(ev)}}`);
        }
      }
    };
    walk(zh[mod], en[mod], '');
  }
  if (mism.length) throw new Error(`插值参数不一致：\n${mism.join('\n')}`);
});

// ── ⑤ 宿主判定防回归 ──
// 事故背景：曾用 `typeof import.meta.glob === 'function'` 做 Vite/Node 宿主判定——
// Vite 只替换 glob 调用点，typeof 表达式留在产物中且浏览器运行时恒 undefined，
// 真实应用误走空包分支，全界面显示原始 key（单测走 esbuild 注入分支，恰好测不到）。
// 本断言禁止该反模式回流。
await check('i18n 源码禁止 typeof import.meta.glob 运行时宿主判定', () => {
  const src = fs.readFileSync(path.join(SRC, 'i18n', 'index.ts'), 'utf8');
  // 剥注释后再查（事故说明注释里会提及该反模式）
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (/typeof\s+import\.meta\.glob/.test(code)) {
    throw new Error('发现 `typeof import.meta.glob` 运行时判定——Vite 产物中恒 false，会导致语言包为空（见 2026-10-15 真机事故）');
  }
  if (!/try\s*{/.test(code) || !/import\.meta\.glob/.test(code)) {
    throw new Error('glob 收集必须为「直接调用 + try/catch 兜底」形态');
  }
});

console.log(`\ni18n: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);

#!/usr/bin/env node
// i18n 占位符门禁（第三轮审查新增）
//
// 两个真实缺陷形态（都出现过，且都不会被任何现有门禁发现）：
//   ① 文案写成 `{{tool}}`：插值器只认单花括号 → 命中内层 `{tool}` →
//      渲染成 `{shell}`（用户看到多一层括号）。既不报缺 key、也不算硬编码中文，
//      `i18n-scan.mjs` / `i18n-modcheck.mjs` 全绿。
//   ② zh 用 `{ms}`、en 用 `{time}`：key 对齐检查通过，但有一侧会把占位符原样吐给用户。
//
// 因此本套件守两条：**语料里不许出现双花括号**、**同一 key 在 zh/en 的占位符集合必须相等**。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOCALES = path.join(ROOT, 'renderer', 'src', 'i18n', 'locales');
const ZH = path.join(LOCALES, 'zh-CN');
const EN = path.join(LOCALES, 'en-US');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 递归收集叶子节点（嵌套 JSON 用点号路径，与运行时 lookup 同构） */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else if (typeof v === 'string') out[key] = v;
  }
  return out;
}

const files = existsSync(ZH) ? readdirSync(ZH).filter((f) => f.endsWith('.json')).sort() : [];
const PLACEHOLDER = /\{(\w+)\}/g;

// ① 双花括号：全语料零容忍（插值器已兼容，但会与翻译工具/后续实现漂移）
{
  const bad = [];
  for (const dir of [ZH, EN]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const raw = readFileSync(path.join(dir, f), 'utf8');
      if (raw.includes('{{')) bad.push(`${path.basename(dir)}/${f}`);
    }
  }
  check('语料里不得出现双花括号占位符 {{x}}（只允许约定的 {x}）',
    bad.length === 0, bad.length ? `命中：${bad.join(', ')}` : '');
}

// ② zh/en 占位符集合必须一致
{
  const mismatches = [];
  let compared = 0;
  for (const f of files) {
    const enPath = path.join(EN, f);
    if (!existsSync(enPath)) continue; // key 文件缺失由 i18n-modcheck 负责，这里不重复报
    const zh = flatten(JSON.parse(readFileSync(path.join(ZH, f), 'utf8')));
    const en = flatten(JSON.parse(readFileSync(enPath, 'utf8')));
    for (const [key, zhText] of Object.entries(zh)) {
      const enText = en[key];
      if (typeof enText !== 'string') continue;
      const setOf = (s) => new Set([...String(s).matchAll(PLACEHOLDER)].map((m) => m[1]));
      const a = setOf(zhText);
      const b = setOf(enText);
      compared += 1;
      const onlyZh = [...a].filter((x) => !b.has(x));
      const onlyEn = [...b].filter((x) => !a.has(x));
      if (onlyZh.length || onlyEn.length) {
        mismatches.push(`${f}:${key} zh独有=[${onlyZh}] en独有=[${onlyEn}]`);
      }
    }
  }
  check(`zh/en 同 key 的占位符集合一致（比对 ${compared} 条）`,
    mismatches.length === 0, mismatches.slice(0, 5).join(' | '));
  // 反向自检：比对数为 0 说明扫描没生效（比失败更危险：它会让上面那条恒绿）
  check('比对样本数 > 0（防扫描域为空导致恒绿）', compared > 0, `compared=${compared}`);
}

console.log(`\ni18n-placeholder: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;

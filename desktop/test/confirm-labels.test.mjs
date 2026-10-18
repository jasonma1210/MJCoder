#!/usr/bin/env node
// 确认框按钮文案门禁（2026-10-18）
//
// 真实缺陷（用户截图）：定时任务「允许对外动作」的确认框，确认按钮写着「确认删除」。
// 根因：`confirm({ danger: true })` 的默认确认文案是 `feedback.confirmDanger`（"确认删除"）——
// 把「危险（红色）」和「删除」绑死了。danger 表达的只是**视觉强度**，不是动作语义。
//
// 本套件守一条：**每个 danger 确认都必须自带 confirmLabel**（显式说明要确认什么）。
// 判据：删掉任一 confirmLabel、或新增一个只传 danger 的确认框 —— 必须变红。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'renderer', 'src');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(jsx|tsx|js|ts)$/.test(name)) out.push(p);
  }
  return out;
}

/** 从 `confirm({` 的花括号开始做配平，取出整段调用实参文本 */
function confirmBlocks(text) {
  const blocks = [];
  const re = /confirm\(\{/g;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length - 1; // 指向 '{'
    let depth = 0;
    let i = start;
    let inStr = null;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (inStr) {
        if (ch === '\\') { i += 1; continue; }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const line = text.slice(0, m.index).split('\n').length;
    blocks.push({ text: text.slice(start, i + 1), line });
  }
  return blocks;
}

/** 抹掉注释（保留换行以保住行号）。不抹注释会把文档注释里的示例代码当成真实调用 —— 
 *  实测：feedback.jsx 头部注释与 SettingsModal 的说明注释都被误判成"违规调用"。 */
function blankComments(src) {
  let out = '';
  let i = 0;
  let inStr = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inStr) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (ch === '/' && next === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i += 1; }
      out += '  ';
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const files = walk(SRC);
check('扫描到源码文件（扫描域自检，防路径写错导致恒绿）', files.length >= 90, `${files.length} 个文件`);

const violations = [];
let dangerCount = 0;
for (const f of files) {
  const text = blankComments(readFileSync(f, 'utf8'));
  for (const b of confirmBlocks(text)) {
    if (!/danger:\s*true/.test(b.text)) continue;
    dangerCount += 1;
    if (!/confirmLabel/.test(b.text)) {
      violations.push(`${path.relative(ROOT, f)}:${b.line}`);
    }
  }
}
check('至少扫到若干 danger 确认（防正则失效后静默全过）', dangerCount >= 5, `danger 确认 ${dangerCount} 处`);
check('每个 danger 确认都自带 confirmLabel（不能落到「确认删除」默认文案）',
  violations.length === 0, violations.join(', '));

// 反向自检：把一段只传 danger 的调用喂进同一判定，必须被判违规
{
  const sample = "confirm({ title: 'x', message: 'y', danger: true })";
  const bad = confirmBlocks(sample).filter((b) => /danger:\s*true/.test(b.text) && !/confirmLabel/.test(b.text));
  check('反向自检：只传 danger 的调用会被判违规（断言不是哑的）', bad.length === 1);
  const good = "confirm({ title: 'x', danger: true, confirmLabel: '开启' })";
  check('反向自检：带 confirmLabel 的不判违规', confirmBlocks(good).every((b) => /confirmLabel/.test(b.text)));
}

console.log(`\nconfirm-labels: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;

// T3-2 工具：扫描源文件中「注释剥离后」的中文残留（提示文案裸中文门禁与抽取组自检共用）。
// 用法：node scripts/i18n-scan.mjs <文件或目录>...
// 目录递归 .js/.jsx/.ts/.tsx；输出每个含中文的行号与内容；有残留 exit 1。
//
// 注释剥离用状态机（非正则近似）：正确处理字符串/模板串内的 // 与 /*（如 URL），
// 模板串 ${expr} 视为字符串内部——其中中文本就应抽取，误判方向安全。
import fs from 'node:fs';
import path from 'node:path';

// CJK 汉字（基本+扩展A）+ 中文标点（U+3000-303F）+ 全角形式（U+FF00-FFEF）
const HAN = [
  '\\u3400-\\u4DBF', '\\u4E00-\\u9FFF', '\\u3000-\\u303F', '\\uFF00-\\uFFEF',
].join('');
const HAN_RE = new RegExp(`[${HAN}]`);

function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // 状态：code / line / block / sq / dq / tpl（模板串，含嵌套计数）
  let st = 'code';
  let tplBrace = 0;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (st === 'code') {
      if (c === '/' && c2 === '/') { st = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { st = 'block'; i += 2; continue; }
      if (c === "'") { st = 'sq'; out += c; i++; continue; }
      if (c === '"') { st = 'dq'; out += c; i++; continue; }
      if (c === '`') { st = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (st === 'line') {
      if (c === '\n') { st = 'code'; out += c; }
      i++; continue;
    }
    if (st === 'block') {
      if (c === '*' && c2 === '/') { st = 'code'; i += 2; continue; }
      // 保留换行以维持行号
      if (c === '\n') out += c;
      i++; continue;
    }
    // 字符串态：处理转义，内容原样保留（中文残留正是要抓的）
    if (st === 'sq' || st === 'dq') {
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if ((st === 'sq' && c === "'") || (st === 'dq' && c === '"')) st = 'code';
      if (c === '\n') { st = 'code'; } // 未闭合引号容错（普通串不跨行）
      out += c; i++; continue;
    }
    if (st === 'tpl') {
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '$' && c2 === '{') { tplBrace++; out += c; i++; continue; }
      if (c === '}' && tplBrace > 0) { tplBrace--; out += c; i++; continue; }
      if (c === '`' && tplBrace === 0) { st = 'code'; }
      out += c; i++; continue;
    }
  }
  return out;
}

function collectFiles(targets) {
  const files = [];
  for (const t of targets) {
    const st = fs.statSync(t);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(t)) {
        const p = path.join(t, f);
        const s2 = fs.statSync(p);
        if (s2.isDirectory()) files.push(...collectFiles([p]));
        else if (/\.(jsx?|tsx?)$/.test(f)) files.push(p);
      }
    } else if (/\.(jsx?|tsx?)$/.test(t)) files.push(t);
  }
  return files;
}

const args = process.argv.slice(2);
// --ipc-payloads：主进程定向模式。main/ 里大量中文在 console.*（开发者面，不进 UI），
// 全量扫会把门禁打成红海。此模式只抓「事件/IPC 载荷字段」（text/error/title/message/
// hint/summary）里的中文——这些才会经 tasks:event / IPC 响应进入用户界面。
// 且恒 exit 0（报告模式）：调用方（test/i18n.test.mjs）自行决定哪些文件纳入棘轮门禁。
const IPC_PAYLOADS = args.includes('--ipc-payloads');
const targets = args.filter((a) => a !== '--ipc-payloads');
if (!targets.length) { console.error('用法：node scripts/i18n-scan.mjs [--ipc-payloads] <文件或目录>...'); process.exit(2); }
let bad = 0;
for (const f of collectFiles(targets)) {
  const rawLines = fs.readFileSync(f, 'utf8').split('\n');
  const stripped = stripComments(rawLines.join('\n')).split('\n');
  stripped.forEach((line, idx) => {
    // 豁免：原行含 i18n-literal 标记（语言自称等不可翻译字面量）
    if (/i18n-literal/.test(rawLines[idx] || '')) return;
    if (!HAN_RE.test(line)) return;
    if (IPC_PAYLOADS) {
      const t = line.trim();
      if (/^console\./.test(t)) return; // 开发者日志不进 UI
      if (!/\b(text|error|title|message|hint|summary)\s*:\s*['"`]/.test(t)) return; // 只抓载荷字段
    }
    console.log(`${f}:${idx + 1}: ${line.trim().slice(0, 120)}`); bad++;
  });
}
console.log(bad ? `裸中文残留：${bad} 行` : '裸中文残留：0（通过）');
process.exit(bad && !IPC_PAYLOADS ? 1 : 0);

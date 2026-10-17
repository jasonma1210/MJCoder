// 渲染层 UI 约定门禁（S0）：零依赖静态检查，防止规范回潮
// 基线为 2026-10-13 实测值：只允许下降，不允许上升（ratchet 式收紧）。
// 修改组件后若本测试失败，要么修到基线以下，要么把基线调低（禁止调高）。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'renderer', 'src');
// 2026-10-13 S0 收紧：硬编码色清零后基线归零（ratchet 只允许下降）
const BASELINE = {
  emoji: 0,        // 零 emoji / 零装饰性字形（▾ ■ ↑ ＋ ⚠ 等）
  rawZIndex: 0,    // 禁止裸 z-index，须用 --z-* 令牌
  paletteColor: 0, // 硬编码 Tailwind 调色板色（text-red-400 等），一律换语义色
  hexColor: 0,     // 组件内十六进制色（主题色板等数据已外置 lib/themes.json）
  deadButton: 0,   // 无 onClick 的 button（装饰性死按钮）
  rawIpc: 0,       // 渲染层禁止 require('electron') / 直接摸 ipcRenderer（须走 preload 桥）
};

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const EMOJI = /[■▾↑＋⚠•\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const PALETTE = /(?:text|bg|border)-(?:red|green|yellow|gray|blue|black)-/g;
const HEX = /#[0-9a-fA-F]{3,6}\b/g;
const ZRAW = /z-\[/g;
const RAWIPC = /require\(['"]electron['"]\)|\bipcRenderer\b/g;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(jsx?|tsx?)$/.test(e.name)) out.push(full);
  }
  return out;
}

// ── 注释屏蔽（2026-10-18 修假阳性）──
// 把注释内容替换为空格、**保留换行**（行号不变），再交给规则扫描。
// 为什么必须做：注释既不可能渲染成 UI，也不可能真的 require('electron')。
// 实测（本轮）有 3 处命中全部落在注释里，属扫描器假阳性：
//   · `components/ui/Switch.tsx:9` —— 注释在解释 W3C Switch Pattern，含字面量 `<button>`
//   · `hooks/useMcpStatus.ts:103` —— 注释在解释「避免每个消费方各挂一个 ipcRenderer 监听」，
//     而该行代码实际走的是 `window.mjcode` 桥（完全合规）
//   · `lib/modelWindows.ts:7` —— 注释里用 ⚠️ 标注「两处取值有意偏离施工单」
// 假阳性的代价是实打实的：它逼迫作者为了过门禁写更差/更含糊的注释，且让真违规淹没在噪声里。
// 语义不变：只屏蔽「不可能被渲染/执行」的内容，规则强度不降（下方自检专门守这一点）。
function blankComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (_m, p1) => p1);
}

const files = walk(SRC).filter((f) => !f.includes(`${path.sep}styles${path.sep}`));
const typedFiles = files.filter((f) => /\.tsx?$/.test(f));
const counts = { emoji: 0, rawZIndex: 0, paletteColor: 0, hexColor: 0, deadButton: 0, rawIpc: 0 };
const samples = { emoji: [], rawZIndex: [], paletteColor: [], hexColor: [], deadButton: [], rawIpc: [] };

for (const file of files) {
  const rel = path.relative(SRC, file);
  const code = blankComments(fs.readFileSync(file, 'utf8'));
  const lines = code.split('\n');
  const mark = (key, lineNo, text) => {
    counts[key] += 1;
    if (samples[key].length < 5) samples[key].push(`${rel}:${lineNo} ${text}`);
  };

  lines.forEach((line, i) => {
    if (EMOJI.test(line)) mark('emoji', i + 1, line.trim().slice(0, 60));
    (line.match(ZRAW) || []).forEach(() => mark('rawZIndex', i + 1, line.trim().slice(0, 60)));
    (line.match(PALETTE) || []).forEach((m) => mark('paletteColor', i + 1, m));
    (line.match(HEX) || []).forEach((m) => mark('hexColor', i + 1, m));
    (line.match(RAWIPC) || []).forEach((m) => mark('rawIpc', i + 1, m));
  });

  // 死按钮启发式：<button 起至闭合标签前没有 onClick
  const idx = [];
  let pos = code.indexOf('<button');
  while (pos !== -1) { idx.push(pos); pos = code.indexOf('<button', pos + 1); }
  for (const p of idx) {
    // 先屏蔽箭头函数 "=>" 中的 ">" ，避免把 onClick={() => ...} 误判为标签结束
    const seg = code.slice(p, p + 600).replace(/=>/g, '==');
    const closeIdx = seg.indexOf('>');
    const head = closeIdx === -1 ? seg : seg.slice(0, closeIdx);
    const lineNo = code.slice(0, p).split('\n').length;
    if (!/onClick|onMouseDown|type="submit"/.test(head)) mark('deadButton', lineNo, head.trim().slice(0, 60));
  }
}

// ── 自检：屏蔽注释**不得**把真违规一起屏蔽掉（防「恒零」假绿）──
// 若有人把 blankComments 写成 `return ''`，上面 6 条会全绿——这是本门禁唯一的失效模式。
{
  const realViolations = "const a = <button>x</button>;\nconst b = require('electron');\nconst c = '⚠';\n";
  const commentOnly = "// 注释里提到 <button> 与 ipcRenderer 与 ⚠️ 不算违规\n/* 块注释里也提到 <button> ipcRenderer ⚠ */\n";
  const codeReal = blankComments(realViolations);
  const codeComment = blankComments(commentOnly);
  const has = (s, re) => (s.match(re) || []).length;
  check('自检：代码里的真违规仍被统计（<button> / require(electron) / emoji 各 1）',
    has(codeReal, /<button/g) === 1 && has(codeReal, RAWIPC) === 1 && has(codeReal, EMOJI) === 1,
    `<button>=${has(codeReal, /<button/g)} rawIpc=${has(codeReal, RAWIPC)} emoji=${has(codeReal, EMOJI)}`);
  check('自检：注释里的同形文本被屏蔽（行注释 + 块注释都不计入）',
    has(codeComment, /<button/g) === 0 && has(codeComment, RAWIPC) === 0 && has(codeComment, EMOJI) === 0,
    `<button>=${has(codeComment, /<button/g)} rawIpc=${has(codeComment, RAWIPC)} emoji=${has(codeComment, EMOJI)}`);
  check('自检：屏蔽注释保留行号（替换为空格而非删除）',
    blankComments('a\n// x\nb').split('\n').length === 3,
    `行数=${blankComments('a\n// x\nb').split('\n').length}`);
}

check('零 emoji / 零装饰性字形', counts.emoji === BASELINE.emoji, `${counts.emoji}/${BASELINE.emoji} ${samples.emoji.join(' | ')}`);
check('无裸 z-index（须用 z-* 令牌）', counts.rawZIndex <= BASELINE.rawZIndex, `${counts.rawZIndex}/${BASELINE.rawZIndex} ${samples.rawZIndex.join(' | ')}`);
check('硬编码调色板色不超过基线', counts.paletteColor <= BASELINE.paletteColor, `${counts.paletteColor}/${BASELINE.paletteColor} ${samples.paletteColor.join(' | ')}`);
check('组件内十六进制色不超过基线', counts.hexColor <= BASELINE.hexColor, `${counts.hexColor}/${BASELINE.hexColor} ${samples.hexColor.join(' | ')}`);
check('无装饰性死按钮', counts.deadButton <= BASELINE.deadButton, `${counts.deadButton}/${BASELINE.deadButton} ${samples.deadButton.join(' | ')}`);
check('渲染层无裸 electron/ipcRenderer（须走 preload 桥）', counts.rawIpc <= BASELINE.rawIpc, `${counts.rawIpc}/${BASELINE.rawIpc} ${samples.rawIpc.join(' | ')}`);

check('扫描到渲染层文件', files.length > 10, `${files.length} 个文件`);
check('UI 规范扫描纳入 TypeScript/TSX', typedFiles.length > 0, `${typedFiles.length} 个 TS/TSX 文件`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);

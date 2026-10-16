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

const files = walk(SRC).filter((f) => !f.includes(`${path.sep}styles${path.sep}`));
const typedFiles = files.filter((f) => /\.tsx?$/.test(f));
const counts = { emoji: 0, rawZIndex: 0, paletteColor: 0, hexColor: 0, deadButton: 0, rawIpc: 0 };
const samples = { emoji: [], rawZIndex: [], paletteColor: [], hexColor: [], deadButton: [], rawIpc: [] };

for (const file of files) {
  const rel = path.relative(SRC, file);
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
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
  let pos = src.indexOf('<button');
  while (pos !== -1) { idx.push(pos); pos = src.indexOf('<button', pos + 1); }
  for (const p of idx) {
    // 先屏蔽箭头函数 "=>" 中的 ">" ，避免把 onClick={() => ...} 误判为标签结束
    const seg = src.slice(p, p + 600).replace(/=>/g, '==');
    const closeIdx = seg.indexOf('>');
    const head = closeIdx === -1 ? seg : seg.slice(0, closeIdx);
    const lineNo = src.slice(0, p).split('\n').length;
    if (!/onClick|onMouseDown|type="submit"/.test(head)) mark('deadButton', lineNo, head.trim().slice(0, 60));
  }
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

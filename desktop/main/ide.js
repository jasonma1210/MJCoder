// IDE 跳转（P0-体验补课）：从代码视图一键跳到用户既有编辑器
// 纯函数部分（候选命令选择）便于单测；实际探测由 main.js 用 execFile('which') 完成。
'use strict';

// 各平台的 IDE 候选（按优先级）：VS Code → Cursor → 系统默认文本打开
const IDE_CANDIDATES = {
  darwin: ['code', 'cursor', 'windsurf'],
  win32: ['code.cmd', 'cursor.cmd', 'windsurf.cmd'],
  linux: ['code', 'cursor', 'windsurf'],
};

const FALLBACK = {
  darwin: { cmd: 'open', args: ['-t'] },         // 系统默认文本编辑器
  win32: { cmd: 'explorer', args: [] },
  linux: { cmd: 'xdg-open', args: [] },
};

// available: 探测到的可用命令集合（由调用方 which 探测后传入）
function pickIde(platform, available) {
  const cands = IDE_CANDIDATES[platform] || IDE_CANDIDATES.linux;
  const set = new Set(available || []);
  const hit = cands.find((c) => set.has(c));
  if (hit) return { cmd: hit, args: [], ide: 'editor' };
  return { ...FALLBACK[platform] || FALLBACK.linux, ide: 'system' };
}

module.exports = { IDE_CANDIDATES, FALLBACK, pickIde };

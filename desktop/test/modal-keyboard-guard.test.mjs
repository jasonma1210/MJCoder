#!/usr/bin/env node
// 浮层键盘接管结构门禁（P2-12 的可行部分）
//
// 为什么是"结构"而不是"行为"：本仓没有 jsdom（只有 react-dom/server 做 SSR），
// 键盘事件无法在 Node 里真实触发。但 P1-3 那类缺陷——「Esc 关错层、用户填了一半的
// 连接器变量/Key 全丢」——的**代码前提**是可以静态钉住的：
//   ① 叠加在面板内部的子浮层必须自己处理 Esc（并阻止冒泡到外层 Modal）；
//   ② 它必须能被 Modal 的「别人的对话框接管键盘」判据识别（aria-modal / 入栈）；
//   ③ 宿主必须在子浮层打开时禁用底层 Modal 的 Esc。
// 删掉任一条件即复发，所以这层门禁有真实判别力（虽不能替代真机键盘回归）。
//
// 真机待验（Node 无法覆盖）：Tab 环、Esc 关闭、焦点归还、遮罩侧边点击关闭。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(DESKTOP, 'renderer/src/components');
const read = (p) => {
  const f = path.join(SRC, p);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
};

// ── 自检：路径必须真的读到（防路径写错后全绿）──────
const ccd = read('ConnectorConfigDialog.tsx');
const eco = read('EcosystemModal.jsx');
const modal = read('ui/Modal.tsx');
const fb = read('feedback.jsx');
check('四个被测文件均存在且非空',
  [ccd, eco, modal, fb].every((s) => typeof s === 'string' && s.length > 500));

// ── ① 子浮层自挂 Esc 并阻止冒泡 ─────────────────
// ⚠️ 断言必须锚定到 Esc 分支**内部**：文件里还有 `onClick={(e) => e.stopPropagation()}`
// （点面板不穿透），用裸 /stopPropagation\(\)/ 会被它满足 → 哑断言（本套件首版就是这么错的）。
const escBlock = (ccd?.match(/if\s*\(e\.key\s*!==\s*'Escape'\)\s*return;[\s\S]{0,300}/) || [''])[0];
check('ConnectorConfigDialog 有独立的 Esc 分支', escBlock.length > 0);
check('Esc 分支内 preventDefault + stopPropagation + onClose 三者齐备',
  /preventDefault\(\)/.test(escBlock) && /stopPropagation\(\)/.test(escBlock) && /onClose\(\)/.test(escBlock),
  escBlock ? 'escBlock 已定位' : '未定位到 Esc 分支');
check('ConnectorConfigDialog 在 capture 阶段监听 keydown（先于 Modal 的冒泡/捕获顺序）',
  !!ccd && /addEventListener\('keydown',\s*onKey,\s*true\)/.test(ccd));

// ── ② 可被「别人的对话框接管键盘」判据识别 ─────────
check('ConnectorConfigDialog 暴露 aria-modal（供 Modal 的 foreignDialog 判据识别）',
  !!ccd && /aria-modal="true"/.test(ccd));
check('ConnectorConfigDialog 打开时获得焦点（负责键盘接管的前提）',
  !!ccd && /panelRef\.current\?\.focus\(\)/.test(ccd));

// ── ③ 宿主在子浮层打开时禁用底层 Esc ───────────
check('EcosystemModal 在 cfgConnector 打开时禁用底层 closeOnEsc',
  !!eco && /closeOnEsc=\{!cfgConnector\}/.test(eco));

// ── Modal 侧的契约 ───────────────────────────
check('ui/Modal 实现 closeOnEsc 开关',
  !!modal && /closeOnEsc/.test(modal));
check('ui/Modal 有「别人的对话框接管键盘」让路判据',
  !!modal && /foreignDialogOwnsFocus/.test(modal));

// ── 既有命令式确认层仍有语义角色（P1-3 之前就存在，防被删）──
check('feedback.confirm 保留 role="alertdialog" + aria-modal',
  !!fb && /alertdialog/.test(fb) && /aria-modal/.test(fb));

console.log(`\nmodal-keyboard-guard: ${pass}/${pass + fail} 通过`);
console.log('⚠ 真机待验：Tab 环 / Esc 关闭 / 焦点归还 / 遮罩侧边点击（Node 无 jsdom，无法动态测）');
if (fail) process.exitCode = 1;

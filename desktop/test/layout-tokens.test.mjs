// P2-1 布局 token 收敛门禁：间距半档与 rounded-md 禁入（防回潮）
//
// 背景：2026-10-18 P2-1 收敛前，renderer 有 29 档间距 / 6 类圆角，其中 .5 半档
//   （0.5/1.5/2.5/3.5 = 2/6/10/14px）约 350 处——半档是「设计意图不明确」的产物
//   （4px 基尺刻度里的中间态），同类元素各用各的会造成视觉漂移。
// 收敛决议（设计意图，用户拍板）：
//   · 间距统一向上取整：0.5→1 / 1.5→2 / 2.5→3 / 3.5→4（整体略宽松，不挤压文字）；
//   · rounded-md 并入 rounded-lg（6px→8px，控件圆角单档）；
//   · 整数长尾档（p-5 / py-10 等）本期保留为允许档位（px-5 集中在 Input 原语，
//     20→16px 变化可感知，回归风险大于收益）。
// 本门禁断言：renderer 源码中**间距**半档类 0 命中、rounded-md 0 命中。
// 注意：w/h 等尺寸类**不在禁入范围**（尺寸不是间距语义，Dot 等原语合法使用 w-1.5/h-1.5）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../renderer/src');
const SPACING = 'p|px|py|pt|pb|pl|pr|gap|m|mx|my|mt|mb|ml|mr|space-x|space-y';
const HALF_RE = new RegExp(`['\\\`" :](${SPACING})-(0\\.5|1\\.5|2\\.5|3\\.5)\\b`);

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const offenders = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (!/\.(jsx|tsx|ts)$/.test(name)) continue;
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (HALF_RE.test(line) || /\brounded-md\b/.test(line)) {
        offenders.push(`${path.relative(ROOT, p)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
})(ROOT);

check('间距半档类（0.5/1.5/2.5/3.5）已全部收敛', offenders.filter((l) => /\-(0\.5|1\.5|2\.5|3\.5)\b/.test(l)).length === 0,
  `残留 ${offenders.filter((l) => /\-(0\.5|1\.5|2\.5|3\.5)\b/.test(l)).length} 处`);
check('rounded-md 已并入 rounded-lg（控件圆角单档）',
  offenders.filter((l) => /\brounded-md\b/.test(l)).length === 0,
  `残留 ${offenders.filter((l) => /\brounded-md\b/.test(l)).length} 处`);
if (offenders.length) {
  console.log('\n残留明细（前 20 条）：');
  offenders.slice(0, 20).forEach((l) => console.log('  ' + l));
}

console.log(`\nlayout-tokens: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);

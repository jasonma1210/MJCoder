// T2-3 门禁：God File「只减不增」基线清单
// 背景：M2 已把 main.js（3040→1101）与 ChatArea.jsx（1809→442）拆薄，
// 但 lint 的 max-lines 只能拦 >1500（error），800 行的「黄线」需要机器化留痕，
// 否则下一次膨胀无人知晓。
// 规则：
//   1) 源码目录（main / renderer/src / agent-core）内 >800 行的文件必须全部在基线清单里——
//      新文件超 800 行直接红；清单条目只能随拆薄减少，禁止新增。
//   2) eslint.config.mjs 的 max-lines 豁免清单必须与实际 >1500 文件集合一致——
//      文件拆薄到 1500 以下后必须从豁免清单删除（防豁免清单变成永久挡箭牌）。
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DESKTOP = path.join(__dirname, '..');
const DIRS = ['main', path.join('renderer', 'src'), 'agent-core'];
const EXTS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'assets']);

// 800 行软档基线（2026-10-15 实测，T2-1/T2-2 拆分完成后）。只减不增。
const BASELINE_800 = [
  'main/computerUse.js',
  'main/main.js',
  'renderer/src/components/SettingsModal.jsx',
  'agent-core/index.js',
];

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(name))) out.push(p);
  }
  return out;
}

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

const files = [];
for (const d of DIRS) walk(path.join(DESKTOP, d), files);
const rel = (p) => path.relative(DESKTOP, p).split(path.sep).join('/');
const over = (p, limit) => fs.readFileSync(p, 'utf8').split('\n').length > limit;

const over800 = files.filter((f) => over(f, 800)).map(rel).sort();
const over1500 = files.filter((f) => over(f, 1500)).map(rel).sort();

check(`>800 行文件全部在基线清单内（当前 ${over800.length} 个）`, () => {
  const added = over800.filter((f) => !BASELINE_800.includes(f));
  assert.deepEqual(added, [], `新文件超过 800 行（God File 苗头，先拆再合入）：${added.join(', ')}`);
});

check('基线清单只减不增（已消失的条目应同步移出）', () => {
  const stale = BASELINE_800.filter((f) => !over800.includes(f));
  assert.deepEqual(stale, [], `以下文件已拆薄到 800 行以下，请把它们从 BASELINE_800 移除：${stale.join(', ')}`);
});

check('eslint max-lines 豁免清单与实际 >1500 文件一致', () => {
  const cfg = fs.readFileSync(path.join(DESKTOP, 'eslint.config.mjs'), 'utf8');
  // 2026-10-15：去账户页后 SettingsModal.jsx 降至 1442 行，移出豁免清单（只减不增）
  const block = cfg.match(/files: \[\s*'agent-core\/index\.js',\s*\]/);
  assert.ok(block, '未找到 eslint 豁免清单（结构变化请同步本测试）');
  assert.deepEqual(over1500, ['agent-core/index.js'],
    `>1500 行文件集合已变化（当前：${over1500.join(', ')}），请同步 eslint.config.mjs 豁免清单与本测试`);
});

console.log(`\nmax-lines: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);

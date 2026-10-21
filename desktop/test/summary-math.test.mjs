// 第八轮 C-04：测试基线汇总口径 —— 「跳过」不得计进「通过」
//
// 缺陷形态（第八轮 C-04 实测）：`run-all.mjs` 的汇总是一行内联表达式
//     `通过 = 套件数 + 门禁数 − 失败数`
// 于是 darwin 上从未真跑的 3 个沙箱套件被算成「通过」，汇总报「通过 259 · 失败 0」。
// 这是本项目最忌讳的一种假绿：**用「没验」冒充「验过」**。它比红更危险，
// 因为红会被人处理，而「全绿」会让人停止复核。
//
// 本套件锁五件事：
//   ① 无跳过时口径不变（零回归）；
//   ② 有跳过时从「通过」里扣掉，且 `通过+失败+跳过 === 总计` 恒成立（等式自洽）；
//   ③ 同一套件打印多行 ⚠ 只算一次（按套件去重，不按行数）；
//   ④ 既失败又报告跳过的项**只计失败**（否则同一项被扣两次，等式会破）；
//   ⑤ run-all.mjs 真的调用了这个口径，且旧的一行公式已不存在（防回退）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { summarize } from './helpers/summary.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const line = (suite) => ({ suite, detail: '⚠ 本节未执行' });

// ── ① 无跳过：与旧口径一致（零回归）──
{
  const r = summarize({ total: 259, failed: [], skipLines: [] });
  check('① 无跳过：通过 = 总计（旧行为不变）', r.passed === 259 && r.skipped === 0 && r.ok);
  const r2 = summarize({ total: 259, failed: ['test/a.test.js'], skipLines: [] });
  check('① 有失败：通过 = 总计 − 失败', r2.passed === 258 && r2.failed === 1);
}

// ── ② 有跳过：必须从「通过」里扣掉，且等式自洽 ──
{
  const r = summarize({ total: 259, failed: [], skipLines: [line('s1'), line('s2'), line('s3')] });
  check('② 三个套件跳过 ⇒ 通过 = 259 − 3 = 256（不再是 259）', r.passed === 256, String(r.passed));
  check('② 跳过数单列上报', r.skipped === 3);
  check('② 等式自洽：通过 + 失败 + 跳过 === 总计',
    r.passed + r.failed + r.skipped === r.total, `${r.passed}+${r.failed}+${r.skipped}`);
  check('② ok=true（公式自身没坏）', r.ok === true);
}

// ── ③ 同一套件多行 ⚠ 只算一次 ──
{
  const r = summarize({
    total: 100, failed: [],
    skipLines: [line('sandbox-linux'), line('sandbox-linux'), line('sandbox-linux'), line('sandbox-mac')],
  });
  check('③ 同一套件 3 行 ⚠ 只扣 1（按套件去重，不按行数）', r.skipped === 2, `skipped=${r.skipped}`);
  check('③ 去重后仍满足等式', r.passed + r.failed + r.skipped === r.total);
  check('③ skippedSuites 不含重复项', new Set(r.skippedSuites).size === r.skippedSuites.length);
}

// ── ④ 既失败又跳过：只计失败，不双扣 ──
{
  const r = summarize({ total: 50, failed: ['s1'], skipLines: [line('s1'), line('s2')] });
  check('④ 既失败又跳过 ⇒ 失败计 1、跳过只计另 1 个', r.failed === 1 && r.skipped === 1,
    `failed=${r.failed} skipped=${r.skipped}`);
  check('④ 通过 = 50 − 1 − 1 = 48（没有把 s1 扣两次）', r.passed === 48, String(r.passed));
  check('④ 等式仍自洽（这就是「只计失败」的理由）', r.passed + r.failed + r.skipped === r.total);
}

// ── ⑤ 边界：全跳过 / 扣成负数时 ok=false（公式坏了要报）──
{
  const all = summarize({ total: 3, failed: [], skipLines: [line('a'), line('b'), line('c')] });
  check('⑤ 全部跳过 ⇒ 通过 0、仍 ok（平台限制不是缺陷）', all.passed === 0 && all.ok === true);
  const bad = summarize({ total: 1, failed: ['a', 'b'], skipLines: [] });
  check('⑤ 失败数超过总数 ⇒ ok=false（公式自洽校验生效，不静默给负数）',
    bad.ok === false, `passed=${bad.passed}`);
}

// ── ⑥ 接线：run-all.mjs 用新口径，且旧的一行公式已不存在 ──
{
  const src = fs.readFileSync(path.join(ROOT, 'test/run-all.mjs'), 'utf8');
  check('⑥ run-all 引入了汇总口径模块', /from '\.\/helpers\/summary\.mjs'/.test(src));
  check('⑥ 汇总行打印四项（总计/通过/失败/跳过）',
    /总计 \$\{summary\.total\} · 通过 \$\{summary\.passed\} · 失败 \$\{summary\.failed\} · 跳过 \$\{summary\.skipped\}/.test(src));
  check('⑥ 旧公式「通过 = 套件+门禁−失败」已删除（防回退）',
    !/通过 \$\{suites\.length \+ GATES\.length - failed\.length\}/.test(src));
  check('⑥ 等式不自洽时会显式报错并置非零退出码', /summary\.ok/.test(src) && /汇总等式自洽校验失败/.test(src));
}

void assert;
console.log(`\nsummary-math: ${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;

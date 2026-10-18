// 阻断② 回归门禁：定时任务的成败判定（main/scheduledVerdict.js）
//
// 事故缺口：用户要「输出一份 md 文档」，trace 里是 5 次工具调用 / 0 次写文件，status 却是 success。
// 没有任何东西能发现「产物形态不对」——判定全都看着「有没有抛异常」。
// 本文件把四条判定（未完成措辞 / 引擎闸门 / 零写入 / 交付降级）的事实、优先级与「没数据不判」
// 三条纪律钉死：前三条是误判防线（假失败同样会烧掉用户的信任），最后一条是「零写入」的杀伤力。
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); fail++; }
}

const { judgeRun, detectNoWrite } = require(path.join(ROOT, 'main', 'scheduledVerdict.js'));
const scheduler = require(path.join(ROOT, 'main', 'scheduler.js'));
const DIR = '/Users/x/Documents/.MJCoder/output/娱乐八卦';

check('正样本：写了文件 → success', () => {
  const v = judgeRun({ output: '已写入 news-2026-10-18.md', tools: 6, writes: 3, shellWrites: 0, dir: DIR });
  assert.deepEqual(v, { status: 'success', error: '' });
});

check('正样本：用 shell 重定向写文件（writes=0 但 shellWrites>0）→ success（不能把写过判成没写）', () => {
  const v = judgeRun({ output: 'cat > news-2026-10-18.md 已写入 100 条', tools: 6, writes: 0, shellWrites: 2, dir: DIR });
  assert.equal(v.status, 'success', `shell 重定向写被误判：${v.error}`);
  // 两者都有也算成功
  assert.equal(judgeRun({ output: 'done', tools: 6, writes: 1, shellWrites: 1, dir: DIR }).status, 'success');
});

check('反样本：两个计数都是 0（只回文本）→ failed，文案含目录与「未检测到文件产出」', () => {
  const v = judgeRun({ output: '整理了 100 条新闻摘要，如下……', tools: 5, writes: 0, shellWrites: 0, dir: DIR });
  assert.equal(v.status, 'failed');
  assert.match(v.error, /未产出文件/);
  assert.match(v.error, /未检测到文件产出/);
  assert.match(v.error, /写入 0 次 \/ shell 重定向 0 次/);
  assert.ok(v.error.includes(DIR), '文案没给出产物目录（用户不知道去哪找）');
  assert.match(v.error, /请检查任务提示词/);
});

check('没数据不判：任一计数未知 → 不判（宁可漏判，不可把「文件写了」判成没写）', () => {
  const cases = [
    { writes: null, shellWrites: null }, { writes: undefined, shellWrites: undefined },
    { writes: 0, shellWrites: null }, { writes: null, shellWrites: 0 },
    { writes: NaN, shellWrites: NaN }, { writes: '0', shellWrites: '0' },
  ];
  for (const c of cases) {
    const v = judgeRun({ output: '完成：已抓取 100 条并写入文件', tools: 5, ...c, dir: DIR });
    assert.equal(v.status, 'success', `writes=${String(c.writes)}/shellWrites=${String(c.shellWrites)} 被误判失败：${v.error}`);
  }
});

check('没数据不判：hasVerify === false 时即使 writes===0 也不判（没数据 ≠ 没写文件）', () => {
  const v = judgeRun({ output: '完成', tools: 5, writes: 0, hasVerify: false, dir: DIR });
  assert.equal(v.status, 'success', `把「没有 V 层数据」当成「没写文件」：${v.error}`);
  // 对照：明确有 V 层数据且确实 0 次写入 → 必须判失败
  assert.equal(judgeRun({ output: '完成', tools: 5, writes: 0, shellWrites: 0, hasVerify: true, dir: DIR }).status, 'failed');
});

check('优先级：模型自述「无法完成」时文案是「未完成」，不是「未产出文件」', () => {
  const v = judgeRun({ output: '无法完成本次任务：web_search 工具不存在', tools: 0, writes: 0, dir: DIR });
  assert.equal(v.status, 'failed');
  assert.match(v.error, /无法完成/);
  assert.ok(!v.error.includes('未产出文件'), `文案优先级错了：${v.error}`);
});

check('优先级：引擎闸门（有工具调用）压过「零写入」', () => {
  const v = judgeRun({ output: '任务尚未完成。\n（上下文已到模型窗口（累计 50097 tokens））', tools: 7, writes: 0, dir: DIR });
  assert.match(v.error, /引擎报告任务未完成/);
  assert.ok(!v.error.includes('未产出文件'));
});

check('优先级：零写入压过交付校验降级（事实优先于概率判定）', () => {
  const v = judgeRun({ output: '完成', tools: 2, writes: 0, shellWrites: 0, dir: DIR, delivery: { downgrade: true, reason: 'L3 判不出' } });
  assert.match(v.error, /未产出文件/);
});

check('交付校验降级单独成立时仍判失败（既有行为不变）', () => {
  const v = judgeRun({ output: '完成', tools: 2, writes: 1, shellWrites: 0, dir: DIR, delivery: { downgrade: true, reason: '守卫型 L3 判 FLAG' } });
  assert.equal(v.status, 'failed');
  assert.match(v.error, /未通过交付校验/);
  assert.match(v.error, /FLAG/);
});

check('空输出仍然判失败（原有行为不被覆盖）', () => {
  assert.match(judgeRun({ output: '   ', tools: 0, writes: 0, dir: DIR }).error, /空结果/);
});

check('expectsFile:false（任务本来不产文件）→ 零产出不判失败；缺省仍按 true 判', () => {
  const zeros = { output: '已提交并把结论汇报给用户', tools: 3, writes: 0, shellWrites: 0, dir: DIR };
  assert.equal(judgeRun({ ...zeros, expectsFile: false }).status, 'success', '关掉产出校验后仍被判失败（会造成新的假失败 + auto-pause）');
  assert.equal(judgeRun(zeros).status, 'failed', '缺省（未传 expectsFile）必须仍按「要求产出文件」判');
  assert.equal(judgeRun({ ...zeros, expectsFile: true }).status, 'failed');
});

check('零产出文案带可行动指引（告诉用户可以去关掉「要求产出文件」）', () => {
  const v = judgeRun({ output: '只回文本', tools: 5, writes: 0, shellWrites: 0, dir: DIR });
  assert.match(v.error, /关闭「要求产出文件」/);
});

check('detectNoWrite：目录未知时给出可辨认的替代文案（不编造路径）', () => {
  const msg = detectNoWrite(0, 0, '');
  assert.match(msg, /未产出文件/);
  assert.match(msg, /未解析到产物目录/);
});

check('scheduler 转导出仍在（既有调用方与测试不受影响）', () => {
  assert.equal(typeof scheduler.detectUnfinished, 'function');
  assert.equal(typeof scheduler.detectExhausted, 'function');
  assert.match(scheduler.detectExhausted('上下文已到模型窗口'), /引擎报告任务未完成/);
  assert.equal(scheduler.detectUnfinished('已抓取 5 条，其中 2 条无法获取正文', 3), '');
});

console.log(`\nscheduled-verdict: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);

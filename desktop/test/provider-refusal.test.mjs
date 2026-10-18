// C 回归门禁：供应商拒绝不能记成成功
//
// 真机历史：run.output 是 `The request was rejected because it was considered high risk`
// （供应商内容安全拒绝），而 status 记成了 success —— 用户看到绿色「成功」，点开只有一句英文拒绝。
// 这类假成功比失败更坏：失败会让人去看日志，假成功让人以为无事发生。
//
// 判定刻意收窄（防把用户正文误判成失败）：**整条输出很短**且命中供应商固定措辞。
// 本文件同时钉住「该判失败的判失败」与「长产物里出现 risk/safety 字样不误判」。
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

const { isProviderRefusal, classifyProviderError, REFUSAL_MAX_LEN } = require(path.join(ROOT, 'main', 'providerErrors.js'));
const { detectUnfinished } = require(path.join(ROOT, 'main', 'scheduler.js'));

// 真机原文（用户报告里那一句，逐字）
const INCIDENT = 'The request was rejected because it was considered high risk';

check('真机原文被判为供应商拒答', () => {
  assert.equal(isProviderRefusal(INCIDENT), true);
});

check('常见供应商/安全拒答措辞都被覆盖', () => {
  const samples = [
    'Your request was rejected because it was considered high risk.',
    'blocked by the content filter',
    'The response was blocked by content_filter',
    'Rejected because it violates our usage policy',
    'This request was blocked by the safety system',
    'blocked by the moderation service',
    'unsafe content detected',
    'request rejected because of content management policy',
  ];
  for (const s of samples) assert.equal(isProviderRefusal(s), true, `未识别：${s}`);
});

check('整条输出只有一个拒答词/错误码时也算（裸词层）', () => {
  for (const s of ['content_filter', 'Content Filter', 'safety', 'moderation', 'high risk', 'rejected']) {
    assert.equal(isProviderRefusal(s), true, `未识别裸词：${s}`);
  }
});

check('error 路径（providerErrors）对同一句给出 content_filter，两条判定口径一致', () => {
  // 证据：现状的 classifyProviderError 已覆盖异常路径，缺的只是「成功路径」这条路（见 detectUnfinished）
  assert.equal(classifyProviderError(INCIDENT).kind, 'content_filter');
  assert.equal(classifyProviderError('error: content filter triggered').kind, 'content_filter');
});

check('detectUnfinished：有工具调用也判失败（真机形态 5 次调用 + 拒答收尾）', () => {
  const why = detectUnfinished(INCIDENT, 5);
  assert.ok(why, '仍被判成功（这就是那次绿色「成功」）');
  assert.match(why, /内容安全/);
});

check('detectUnfinished：chat 通道（零工具调用）同样判失败', () => {
  assert.ok(detectUnfinished(INCIDENT, 0));
});

check('保守：正常产物不被误判（含 risk / safety / filter 字样的中文结论）', () => {
  const normal = [
    '已抓取 100 条新闻，其中 2 条因站方限制无法获取正文，其余已整理为 100条八卦.md',
    '完成。产出文件：全球娱乐八卦.md（100 条，含风险提示标注）',
    '风险提示：本文含 high risk 话题讨论，已按平台要求标注',
    '已按 content filter 相关规范整理 12 条内容，写入 news.md',
    'Task done: wrote 100 items to news.md',
  ];
  for (const s of normal) assert.equal(isProviderRefusal(s), false, `误判：${s}`);
  assert.equal(detectUnfinished(normal[0], 3), '', '正常输出被判失败');
});

check('长度闸：长文本里出现拒答措辞不算拒答（真实产物优先）', () => {
  const long = `${INCIDENT}\n\n${'某公司今天发布了新产品。'.repeat(60)}`;
  assert.ok(long.length > REFUSAL_MAX_LEN);
  assert.equal(isProviderRefusal(long), false);
});

check('空输出与普通失败措辞不受影响（原有判定不被覆盖）', () => {
  assert.equal(isProviderRefusal(''), false);
  assert.equal(isProviderRefusal('   '), false);
  assert.match(detectUnfinished('', 0), /空结果/);
  assert.match(detectUnfinished('无法完成本次任务，工具不存在', 0), /无法完成/);
});

console.log(`\nprovider-refusal: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);

// A4 回归门禁：续跑恢复必须是**状态驱动**，关键词只能作辅助信号
//
// 旧行为（已修）：只有消息以「继续」/「continue」开头才读取断点。
//   → 用户说「接着做」「接下来呢」时静默不恢复；断点明明存在却被忽略。
// 新语义：只要本会话存在断点就注入恢复上下文（与用户这轮说了什么无关）；
//   关键词仅用于「表达了继续意图但无断点」的留痕与提示。
//
// 本测试直接驱动 shared/resumeIntent.mjs 的行为（不读源码字符串）。
import assert from 'node:assert/strict';
import { looksLikeContinue, resumeDecision } from '../shared/resumeIntent.mjs';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass += 1; }
  catch (e) { console.error(`❌ ${name} — ${e.message}`); fail += 1; }
}

// ── 核心：有断点就必须恢复，措辞无关 ──
const UNRELATED_TEXTS = [
  '把 README 改成英文',
  '接着做',
  '接下来呢',
  '刚才那个继续',
  'go on',
  'resume the task',
  '随便说点什么',
];
for (const text of UNRELATED_TEXTS) {
  check(`有断点时恢复不受措辞影响：「${text}」`, () => {
    const d = resumeDecision({ hasCheckpoint: true, messageText: text });
    assert.equal(d.resume, true, '存在断点即应恢复');
    assert.equal(d.reason, 'checkpoint');
  });
}

// ── 无断点时不恢复（没有东西可恢复，不能凭空注入） ──
check('无断点 + 继续类措辞：不恢复，但留辅助信号', () => {
  const d = resumeDecision({ hasCheckpoint: false, messageText: '继续' });
  assert.equal(d.resume, false);
  assert.equal(d.looksLikeContinue, true);
  assert.equal(d.reason, 'keyword-no-checkpoint');
});

check('无断点 + 普通消息：不恢复且无辅助信号', () => {
  const d = resumeDecision({ hasCheckpoint: false, messageText: '看看这个文件' });
  assert.equal(d.resume, false);
  assert.equal(d.looksLikeContinue, false);
  assert.equal(d.reason, 'no-checkpoint');
});

check('缺省参数不抛错且判定为不恢复（fail-safe）', () => {
  const d = resumeDecision();
  assert.equal(d.resume, false);
  assert.equal(d.looksLikeContinue, false);
});

// ── 辅助信号自身的识别能力（扩展了旧版只认行首「继续/continue」的局限）──
const SHOULD_MATCH = ['继续', 'continue', '接着做', '接下来做吧', '请继续', 'go on', 'resume'];
for (const t of SHOULD_MATCH) {
  check(`识别继续意图：「${t}」`, () => assert.equal(looksLikeContinue(t), true));
}
const SHOULD_NOT_MATCH = ['看看日志', '把这个函数重命名', '读一下 .env 配置', '完成了'];
for (const t of SHOULD_NOT_MATCH) {
  check(`不误判继续意图：「${t}」`, () => assert.equal(looksLikeContinue(t), false));
}

check('非字符串输入不抛错', () => {
  assert.equal(looksLikeContinue(null), false);
  assert.equal(looksLikeContinue(undefined), false);
  assert.equal(looksLikeContinue({ a: 1 }), false);
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);

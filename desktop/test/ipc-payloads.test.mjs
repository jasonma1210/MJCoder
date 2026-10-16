// D2 回归门禁：任务写通道（tasks:*）载荷契约
//
// 为什么需要：这些 handler 会改任务状态 / 恢复暂停组 / 删除任务组。此前直接解构载荷，
// 畸形输入（缺字段、类型错、多余字段）会深入 store 层才失败或被当成空 id。
// 现在形状固化在 shared-ipc/taskPayloads.mjs，进入业务前校验，不合法即拒绝（fail-closed）。
//
// 断言全部为行为断言：直接喂载荷看结果，不读源码字符串。
import assert from 'node:assert/strict';
import {
  parseIpcPayload,
  taskConfigPayloadSchema,
  taskGroupRefSchema,
  taskRefSchema,
  taskRetryPayloadSchema,
} from '../shared-ipc/taskPayloads.mjs';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass += 1; }
  catch (e) { console.error(`❌ ${name} — ${e.message}`); fail += 1; }
}

// ── 合法载荷 ──
check('合法重试载荷通过并保留 confirmReview', () => {
  const r = parseIpcPayload(taskRetryPayloadSchema, { groupId: 'g1', taskId: 't1', confirmReview: true });
  assert.equal(r.ok, true);
  assert.equal(r.data.groupId, 'g1');
  assert.equal(r.data.taskId, 't1');
  assert.equal(r.data.confirmReview, true);
});

check('confirmReview 缺省为 false（默认要求先核对，不是宽松默认）', () => {
  const r = parseIpcPayload(taskRetryPayloadSchema, { groupId: 'g1', taskId: 't1' });
  assert.equal(r.ok, true);
  assert.equal(r.data.confirmReview, false);
});

check('合法组引用载荷通过', () => {
  assert.equal(parseIpcPayload(taskGroupRefSchema, { groupId: 'g1' }).ok, true);
});

check('合法任务引用载荷通过', () => {
  assert.equal(parseIpcPayload(taskRefSchema, { groupId: 'g1', taskId: 't1' }).ok, true);
});

// ── 非法载荷：必须被拒绝且给出可读原因 ──
const REJECT_CASES = [
  ['缺 groupId', taskGroupRefSchema, {}],
  ['groupId 为空串', taskGroupRefSchema, { groupId: '' }],
  ['groupId 类型错误（数字）', taskGroupRefSchema, { groupId: 123 }],
  ['缺 taskId（任务引用）', taskRefSchema, { groupId: 'g1' }],
  ['taskId 为空串', taskRefSchema, { groupId: 'g1', taskId: '' }],
  ['confirmReview 类型错误（字符串）', taskRetryPayloadSchema, { groupId: 'g1', taskId: 't1', confirmReview: 'yes' }],
  ['载荷为 null', taskGroupRefSchema, null],
  ['载荷为字符串', taskGroupRefSchema, 'g1'],
];
for (const [label, schema, payload] of REJECT_CASES) {
  check(`非法载荷被拒绝：${label}`, () => {
    const r = parseIpcPayload(schema, payload);
    assert.equal(r.ok, false, '应拒绝');
    assert.ok(typeof r.error === 'string' && r.error.includes('IPC 载荷不合法'), `原因应可读，实际=${r.error}`);
  });
}

check('错误原因含字段路径（便于定位，而不是只说"不合法"）', () => {
  const r = parseIpcPayload(taskRefSchema, { groupId: 'g1' });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('taskId'), `应指出缺失字段，实际=${r.error}`);
});

check('错误原因不回显原始载荷内容（避免把超长/敏感输入写进日志）', () => {
  const secret = 'SENSITIVE-VALUE-'.repeat(20);
  const r = parseIpcPayload(taskGroupRefSchema, { groupId: { evil: secret } });
  assert.equal(r.ok, false);
  assert.equal(r.error.includes(secret), false, '不得回显载荷内容');
});

// ── 多余字段被剥离（防止载荷携带未被契约允许的字段穿透到业务层） ──
check('未声明字段被剥离（不进入业务数据）', () => {
  const r = parseIpcPayload(taskGroupRefSchema, { groupId: 'g1', isAdmin: true, __proto__hack: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.data), ['groupId']);
});

// ── 并发上限配置 ──
check('maxConcurrent 负整数被拒绝', () => {
  assert.equal(parseIpcPayload(taskConfigPayloadSchema, { maxConcurrent: -1 }).ok, false);
});
check('maxConcurrent 小数被拒绝（上限必须是整数）', () => {
  assert.equal(parseIpcPayload(taskConfigPayloadSchema, { maxConcurrent: 2.5 }).ok, false);
});
check('maxConcurrent 合法整数通过', () => {
  const r = parseIpcPayload(taskConfigPayloadSchema, { maxConcurrent: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.data.maxConcurrent, 4);
});
check('maxConcurrent 缺省时通过（由 workerPool 取默认值并自行钳制）', () => {
  const r = parseIpcPayload(taskConfigPayloadSchema, {});
  assert.equal(r.ok, true);
  assert.equal(r.data.maxConcurrent, undefined);
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);

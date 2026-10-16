// intentLogRegistry.js 测试：名单例 + will-quit 统一 flush + 白名单断言
//
// 覆盖 R1–R4 + B4：
//   R1 同 name 单例（二次调用返回同一实例，不重复 open）
//   R2 flushAllIntentLogs 覆盖全部已注册日志
//   R3 closeAllIntentLogs 幂等且清空注册表
//   R4 compactIfLarge 阈值判定 + 无快照提供方时跳过
//   B4 白名单断言：遥测日志不得进注册表（裁决 ② 的边界守门）
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const registry = require('../main/data/intentLogRegistry');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function guard(name, fn) {
  try { fn(); check(name, true); }
  catch (e) { check(name, false, e.message); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-registry-'));
const p = (n) => path.join(tmp, n);

// ══ R1 同 name 单例 ══
guard('R1 同 name 二次调用返回同一实例', () => {
  const a = registry.getIntentLog('user-data', p('r1.jsonl'));
  const b = registry.getIntentLog('user-data', p('r1.jsonl'));
  assert.strictEqual(a, b, '必须返回同一实例');
  // 换 file 也不该新建（name 是唯一键）——防止误用导致双写
  const c = registry.getIntentLog('user-data', p('other.jsonl'));
  assert.strictEqual(c, a, '同 name 不同 file 仍应返回原实例');
  assert.deepStrictEqual(registry.listIntentLogs(), ['user-data']);
});

// ══ R2 flushAllIntentLogs 全覆盖 ══
guard('R2 flushAll 覆盖全部已注册日志', () => {
  registry.closeAllIntentLogs(); // 注册表是模块级状态，先清干净再测
  const l1 = registry.getIntentLog('a', p('r2-a.jsonl'));
  const l2 = registry.getIntentLog('b', p('r2-b.jsonl'));
  const l3 = registry.getIntentLog('c', p('r2-c.jsonl'));
  // 各写 3 条但不 flush
  for (const l of [l1, l2, l3]) for (let i = 0; i < 3; i++) l.append({ type: 'x', i });
  assert.strictEqual(l1.stats().buffered, 3);
  const out = registry.flushAllIntentLogs();
  assert.strictEqual(out.length, 3, '应覆盖 3 个日志');
  for (const r of out) {
    assert.strictEqual(r.ok, true, `${r.name} 应 flush 成功`);
    assert.strictEqual(r.records, 3, `${r.name} 应排空 3 条`);
    assert.strictEqual(r.durable, true, `${r.name} 应无挂起`);
  }
  // 三个文件都落盘
  for (const n of ['a', 'b', 'c']) {
    const lines = fs.readFileSync(p(`r2-${n}.jsonl`), 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 3, `${n} 应落盘 3 条`);
  }
});

// ══ R2b flushAll 单个失败不影响其余 ══
guard('R2b flushAll 单个失败不影响其余日志', () => {
  registry.closeAllIntentLogs();
  const good = registry.getIntentLog('good', p('r2b-good.jsonl'));
  const bad = registry.getIntentLog('bad', p('r2b-bad.jsonl'));
  good.append({ type: 'x' });
  bad.append({ type: 'y' });
  // 破坏 bad 的 fd，使 flush 抛错
  const origFsync = fs.fsyncSync;
  let calls = 0;
  fs.fsyncSync = (fd) => {
    calls += 1;
    if (calls === 2) throw new Error('EIO 模拟'); // 第二个日志失败
    return origFsync(fd);
  };
  let out;
  try { out = registry.flushAllIntentLogs(); } finally { fs.fsyncSync = origFsync; }
  const byName = Object.fromEntries(out.map((r) => [r.name, r]));
  assert.strictEqual(byName.good.ok, true, 'good 应成功');
  assert.strictEqual(byName.bad.ok, false, 'bad 应如实报失败');
  assert.ok(typeof byName.bad.error === 'string', 'bad 应带 error');
  // good 的数据必须已落盘
  const lines = fs.readFileSync(p('r2b-good.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1, 'good 的 1 条必须落盘');
});

// ══ R3 closeAllIntentLogs ══
guard('R3 closeAll 幂等且清空注册表', () => {
  registry.getIntentLog('x1', p('r3-1.jsonl')).append({ type: 'a' });
  registry.getIntentLog('x2', p('r3-2.jsonl')).append({ type: 'b' });
  registry.closeAllIntentLogs();
  assert.deepStrictEqual(registry.listIntentLogs(), [], '注册表应清空');
  // 幂等：再调一次不抛错
  registry.closeAllIntentLogs();
  // close 前有未 flush 的缓冲 → close 内部应 flush 落盘
  const lines = fs.readFileSync(p('r3-1.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1, 'close 前未 flush 的缓冲应被落盘');
});

// ══ R4 compactIfLarge ══
guard('R4 compactIfLarge：未达阈值不 compact', () => {
  registry.closeAllIntentLogs();
  const log = registry.getIntentLog('small', p('r4-small.jsonl'));
  log.appendNow({ type: 'a' });
  const sizeBefore = log.logSizeBytes();
  const out = registry.compactIfLarge(() => ({ data: [], file: p('r4-small.snap.json') }), 4 * 1024 * 1024);
  const r = out.find((x) => x.name === 'small');
  assert.strictEqual(r, undefined, '未达阈值应不出现在结果里');
  assert.strictEqual(log.logSizeBytes(), sizeBefore, '日志不应被清空');
});

guard('R4 compactIfLarge：达阈值则 compact 且清空日志', () => {
  const log = registry.getIntentLog('large', p('r4-large.jsonl'));
  for (let i = 0; i < 20; i++) log.appendNow({ type: 'x', i });
  const before = log.logSizeBytes();
  assert.ok(before > 0);
  const snapFile = p('r4-large.snap.json');
  const out = registry.compactIfLarge(() => ({ data: [{ seq: 1 }], file: snapFile }), 10); // 阈值 10B，必然触发
  const r = out.find((x) => x.name === 'large');
  assert.strictEqual(r.ok, true, 'compact 应成功');
  assert.strictEqual(log.logSizeBytes(), 0, '日志应被清空');
  assert.ok(fs.existsSync(snapFile), '快照应落盘');
  assert.strictEqual(log.seq, 0, 'seq 应归零');
});

guard('R4 compactIfLarge：无快照提供方则跳过不炸', () => {
  const log = registry.getIntentLog('nosnap', p('r4-nosnap.jsonl'));
  for (let i = 0; i < 20; i++) log.appendNow({ type: 'x', i });
  const before = log.logSizeBytes();
  const out = registry.compactIfLarge(() => null, 10);
  const r = out.find((x) => x.name === 'nosnap');
  assert.strictEqual(r.ok, false, '无快照提供方应报 ok:false');
  assert.ok(/无快照/.test(r.error), '错误信息应说明原因');
  assert.strictEqual(log.logSizeBytes(), before, '日志不应被清空');
});

// ══ B4 白名单断言：遥测日志不得进注册表（裁决 ② 边界守门）══
// 遥测日志应直接用 durableWrite.appendDurable 原语，不经过 IntentLog/registry。
// 此断言是"防止有人把遥测日志也塞进 registry"的守门——那会把 compact/replay/
// flush 责任全部耦合进来，而遥测一样都不需要。
guard('B4 遥测日志不经过 registry（直接用 appendDurable 原语）', () => {
  const { openAppend, appendDurable, closeFd } = require('../main/data/durableWrite');
  const f = p('decisions.jsonl');
  const fd = openAppend(f);
  assert.ok(typeof fd === 'number' && fd >= 0, 'openAppend 应返回 fd');
  // 遥测写 3 条，每条独立 fsync，无需 registry
  for (let i = 0; i < 3; i++) {
    const r = appendDurable(fd, JSON.stringify({ t: Date.now(), strategy: 'w=3', i }));
    assert.strictEqual(r.ok, true);
  }
  closeFd(fd);
  // 断言：注册表中【没有】这个遥测日志
  assert.ok(!registry.listIntentLogs().includes('decisions'), '遥测日志不得进注册表');
  // 且文件已落盘（每条 appendDurable 自带 fsync，无缓冲故无 flush 责任）
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 3, '遥测应已落盘 3 条');
  for (const l of lines) JSON.parse(l);
});

registry.closeAllIntentLogs();

console.log(`\nintentLogRegistry：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);

// intentLog.js 测试：持久化地基的 15 项契约用例
//
// 覆盖设计文档 §13.7 全 15 项。其中第 3、7、11、12、13、14、15 项为
// 【数据丢失守门】——它们守的都是会静默发生、无任何报错的灾难：
//   坑 1（乱序 seq 被 replay 去重跳过）、坑 2（ftruncate 忘初始化字节账 → 全库归零）、
//   坑 3（open 不清半行 → 新记录粘连丢失）、缺陷 3（字节账过计 → 跳过写入丢记录）。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { IntentLog } = require('../main/data/intentLog');

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-intent-'));
const p = (n) => path.join(tmp, n);

// ══ 1. 组提交丢失窗口 ══
guard('1 组提交丢失窗口（未 flush 即崩溃 → 0 条）', () => {
  const f = p('t1.jsonl');
  const log = new IntentLog(f); log.open();
  for (let i = 0; i < 5; i++) log.append({ type: 'msg', i });
  // 不 flush、不 close，模拟崩溃：缓冲未落盘
  const before = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0;
  assert.strictEqual(before, 0, '未 flush 前文件应为空');
  log.close(); // close 内部 flush → 5 条落盘
  const after = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
  assert.strictEqual(after, 5, 'flush 后应为 5 条');
});

// ══ 2. appendNow 零窗口 ══
guard('2 appendNow 零窗口（返回即持久）', () => {
  const f = p('t2.jsonl');
  const log = new IntentLog(f); log.open();
  const r = log.appendNow({ type: 'cred', v: 'secret' });
  assert.strictEqual(r.durable, true);
  // 不 close、不 flush，直接读文件——appendNow 已 fsync
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1, '未 flush 即应已落盘 1 条');
  assert.strictEqual(JSON.parse(lines[0]).v, 'secret');
  log.close();
});

// ══ 3. 【守门】appendNow 排空缓冲（坑 1：乱序 seq 被 replay 跳过）══
guard('3 坑1 appendNow 排空缓冲后 replay 不丢条', () => {
  const f = p('t3.jsonl');
  const log = new IntentLog(f); log.open();
  for (let i = 0; i < 3; i++) log.append({ type: 't1', i });   // seq 1,2,3 在缓冲
  log.appendNow({ type: 't0', i: 99 });                        // 必须先 flush 掉 1,2,3，再写 4
  log.close();

  const log2 = new IntentLog(f); log2.open();
  const applied = [];
  const rep = log2.replay((r) => applied.push(r));
  assert.strictEqual(rep.applied, 4, `applied 应为 4，实为 ${rep.applied}`);
  assert.deepStrictEqual(applied.map((r) => r.seq), [1, 2, 3, 4], 'seq 必须连续单调');
  log2.close();
});

// ══ 4. 半行容忍 ══
guard('4 半行容忍（末行截断 → open 不抛、取到前一条 seq）', () => {
  const f = p('t4.jsonl');
  const log = new IntentLog(f); log.open();
  log.appendNow({ type: 'a' });   // seq 1
  log.appendNow({ type: 'b' });   // seq 2
  log.close();
  // 人为在末尾写一个截断的半行
  fs.appendFileSync(f, '{"seq":3,"type":"c","v":"half-wri');
  const log2 = new IntentLog(f);
  const r = log2.open();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(log2.seq, 2, '应取到前一条 seq=2');
  assert.ok(fs.readFileSync(f, 'utf8').endsWith('\n'), 'open 后文件应以 \\n 结尾（半行被截掉）');
  // 截断后追加不粘连
  log2.append({ type: 'd' });
  log2.close();
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 3, '应为 3 条完整行');
  assert.strictEqual(JSON.parse(lines[2]).seq, 3, '新记录 seq 应为 3');
});

// ══ 5. 尾部读取一致性（与全扫描逐一相等）══
guard('5 尾部读取一致性（1k/5k/50k/200k 四档）', () => {
  for (const N of [1000, 5000, 50000, 200000]) {
    const f = p(`t5-${N}.jsonl`);
    // 直接写文件（绕过 IntentLog，模拟既有历史）
    const lines = [];
    for (let i = 1; i <= N; i++) lines.push(JSON.stringify({ seq: i, t: 1, type: 'x' }));
    fs.writeFileSync(f, lines.join('\n') + '\n');
    const log = new IntentLog(f); log.open();
    assert.strictEqual(log.seq, N, `N=${N} 尾部读取应为 ${N}`);
    log.close();
  }
});

// ══ 6. fsync 失败行为 ══
guard('6 fsync 失败 → appendNow 抛错（不静默返回成功）', () => {
  const f = p('t6.jsonl');
  const log = new IntentLog(f); log.open();
  const orig = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error('ENOSPC 模拟磁盘满'); };
  let threw = false;
  try { log.appendNow({ type: 'cred' }); }
  catch (e) { threw = /T0 追加失败/.test(e.message); }
  finally { fs.fsyncSync = orig; }
  assert.ok(threw, 'fsync 失败必须抛错');
  // seq 未消耗
  const r2 = log.appendNow({ type: 'cred', v: 'ok' });
  assert.strictEqual(r2.seq, 1, '失败后 seq 应仍从 1 开始（无空洞）');
  log.close();
});

// ══ 7. 【守门】R1：compact 中间态 ══
guard('7 坑/R1 compact 中间态（快照已写、日志未清 → 幂等重放恢复）', () => {
  const f = p('t7.jsonl');
  const snap = p('t7.snapshot.json');
  const log = new IntentLog(f); log.open();
  for (let i = 0; i < 3; i++) log.appendNow({ type: 'msg', i });
  log.close();

  // 人为制造中间态：快照是旧的（只含 seq 1），日志仍有 1,2,3 全部
  fs.writeFileSync(snap, JSON.stringify([{ seq: 1, type: 'msg', i: 0 }]));

  // 恢复：先应用快照，再 replay 日志 → 幂等去重应跳过 seq 1
  const state = [];
  const snapData = JSON.parse(fs.readFileSync(snap, 'utf8'));
  for (const r of snapData) state.push(r);
  const log2 = new IntentLog(f); log2.open();
  const rep = log2.replay((r) => state.push(r), 1); // startSeq=1：快照已应用到 seq 1
  assert.strictEqual(rep.applied, 2, `replay 应只应用 2 条（seq 1 已被快照覆盖），实为 ${rep.applied}`);
  assert.strictEqual(state.length, 3, `应为 3 条（快照 1 + 日志去重后 2），实为 ${state.length}`);
  assert.deepStrictEqual(state.map((r) => r.seq), [1, 2, 3]);
  log2.close();
});

// ══ 8. compact 快照失败不清日志 ══
guard('8 compact 快照失败 → 日志逐字节不变', () => {
  const f = p('t8.jsonl');
  const snap = p('t8.snapshot.json');
  const log = new IntentLog(f); log.open();
  log.appendNow({ type: 'a' });
  log.appendNow({ type: 'b' });
  const before = fs.readFileSync(f, 'utf8');
  // 快照落点不可写（父路径是文件）
  const blocker = p('t8-blocker');
  fs.writeFileSync(blocker, 'x');
  const r = log.compact([], path.join(blocker, 'nope.json'));
  assert.strictEqual(r.ok, false, '快照失败应返回 ok:false');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), before, '日志必须逐字节不变');
  log.close();
});

// ══ 9. seq 跨重启续上 ══
guard('9 seq 跨重启续上', () => {
  const f = p('t9.jsonl');
  const log = new IntentLog(f); log.open();
  const seqs = [];
  for (let i = 0; i < 5; i++) seqs.push(log.append({ type: 'x' }).seq);
  assert.deepStrictEqual(seqs, [1, 2, 3, 4, 5], '连续 append 的 seq 必须递增不重复');
  log.close();
  const log2 = new IntentLog(f); log2.open();
  const r = log2.append({ type: 'y' });
  assert.strictEqual(r.seq, 6, `重启后 seq 应从 6 开始，实为 ${r.seq}`);
  log2.close();
});

// ══ 10. flush() 返回语义（缺陷 2）══
guard('10 flush() 返回 records/durable 三字段', () => {
  const f = p('t10.jsonl');
  const log = new IntentLog(f); log.open();
  log.append({ type: 'a' });
  log.append({ type: 'b' });
  const r = log.flush();
  assert.strictEqual(r.records, 2, 'records 应为本次排空的 2 条');
  assert.strictEqual(r.durable, true, 'flush 后应无挂起');
  assert.strictEqual(typeof r.bytesWritten, 'number');
  // 空缓冲再 flush：records=0，durable 仍 true
  const r2 = log.flush();
  assert.strictEqual(r2.records, 0);
  assert.strictEqual(r2.durable, true);
  log.close();
});

// ══ 11. 【守门】open 后字节账初始化（坑 2：防全库归零）══
guard('11 坑2 open 后字节账初始化（有历史不截断）', () => {
  const f = p('t11.jsonl');
  // 先造 5000 条历史
  const lines = [];
  for (let i = 1; i <= 5000; i++) lines.push(JSON.stringify({ seq: i, t: 1, type: 'x' }));
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const sizeBefore = fs.statSync(f).size;

  const log = new IntentLog(f); log.open();
  assert.strictEqual(log.logSizeBytes(), sizeBefore, 'open 后大小不变');
  assert.strictEqual(log.seq, 5000);
  // 关键：append + flush 不得截断历史
  log.append({ type: 'new' });
  log.flush();
  const after = fs.statSync(f).size;
  assert.ok(after > sizeBefore, `文件应增长（${sizeBefore} → ${after}）`);
  // 历史 5000 条仍在
  const all = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(all.length, 5001, `应 5001 条，实为 ${all.length}`);
  assert.strictEqual(JSON.parse(all[0]).seq, 1, '首条历史必须完好');
  assert.strictEqual(JSON.parse(all[4999]).seq, 5000, '末条历史必须完好');
  log.close();
});

// ══ 12. 【守门】磁盘满后重试不重复不丢失 ══
guard('12 坑3 写失败后重试：无重复行、无丢失', () => {
  const f = p('t12.jsonl');
  const log = new IntentLog(f); log.open();
  log.append({ type: 'a' });
  log.append({ type: 'b' });

  // 模拟 writeSync 写一半后抛错
  const origWrite = fs.writeSync;
  let firstCall = true;
  fs.writeSync = (fd, buf, ...rest) => {
    if (firstCall && buf.length > 20) {
      firstCall = false;
      origWrite(fd, buf.subarray(0, 20)); // 只写 20 字节
      throw new Error('ENOSPC 模拟磁盘满（半写后抛错）');
    }
    return origWrite(fd, buf, ...rest);
  };
  let threw = false;
  try { log.flush(); } catch (e) { threw = true; }
  finally { fs.writeSync = origWrite; }
  assert.ok(threw, '半写后必须抛错');
  assert.strictEqual(log.stats().buffered, 2, '缓冲应保留 2 条');

  // 磁盘恢复，重试
  const r = log.flush();
  assert.strictEqual(r.durable, true);
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 2, `应恰好 2 行（无重复），实为 ${lines.length}`);
  const log2 = new IntentLog(f); log2.open();
  const applied = [];
  log2.replay((x) => applied.push(x));
  assert.strictEqual(applied.length, 2, 'replay 必须两条都在');
  assert.deepStrictEqual(applied.map((x) => x.seq), [1, 2]);
  assert.strictEqual(log2.stats().truncations >= 0, true);
  log2.close();
  log.close();
});

// ══ 13. 【守门】短写抛错（缺陷 3）══
guard('13 缺陷3 短写抛错且字节账不推进', () => {
  const f = p('t13.jsonl');
  const log = new IntentLog(f); log.open();
  log.append({ type: 'a' });
  const wbBefore = log.stats().writeBytes;

  const origWrite = fs.writeSync;
  fs.writeSync = () => 20; // 谎报只写了 20 字节（期望远大于此）
  let threw = false;
  try { log.flush(); } catch (e) { threw = /短写/.test(e.message); }
  finally { fs.writeSync = origWrite; }
  assert.ok(threw, '短写必须抛错');
  assert.strictEqual(log.stats().writeBytes, wbBefore, '字节账不得推进');
  assert.strictEqual(log.stats().buffered, 1, '缓冲应保留');
  log.close();
});

// ══ 14. 【守门】末尾半行被 open 截掉（坑 3：防粘连）══
guard('14 坑3 末尾半行被 open 截掉且后续不粘连', () => {
  const f = p('t14.jsonl');
  const log = new IntentLog(f); log.open();
  log.appendNow({ type: 'a' });
  log.appendNow({ type: 'b' });
  log.close();
  const goodSize = fs.statSync(f).size;

  // 人为追加一个不带 \n 的截断行
  fs.appendFileSync(f, '{"seq":3,"type":"c","v":"no-newline');
  assert.ok(!fs.readFileSync(f, 'utf8').endsWith('\n'), '制造出的末行应无 \\n');

  const log2 = new IntentLog(f);
  log2.open();
  assert.strictEqual(fs.statSync(f).size, goodSize, 'open 应把半行截回原大小');
  assert.ok(fs.readFileSync(f, 'utf8').endsWith('\n'), 'open 后应以 \\n 结尾');
  assert.strictEqual(log2.stats().tailRecoveries, 1, '应记录 1 次尾部恢复');

  // 追加新记录，不得与半行粘连
  log2.append({ type: 'd' });
  log2.close();
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 3, `应 3 条完整行，实为 ${lines.length}`);
  for (const l of lines) JSON.parse(l); // 每行都必须可解析
  log2.close();
});

// ══ 15. 【守门】T0 失败不消耗 seq ══
guard('15 T0 失败不消耗 seq（无空洞）', () => {
  const f = p('t15.jsonl');
  const log = new IntentLog(f); log.open();
  const origFsync = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error('EIO 模拟'); };
  const seqsAttempted = [];
  for (let i = 0; i < 3; i++) {
    try { log.appendNow({ type: 'cred', i }); } catch (e) { seqsAttempted.push('fail'); }
  }
  fs.fsyncSync = origFsync;
  const r = log.appendNow({ type: 'cred', v: 'ok' });
  assert.strictEqual(r.seq, 1, `3 次失败后首次成功 seq 应为 1，实为 ${r.seq}`);
  const r2 = log.appendNow({ type: 'cred', v: 'ok2' });
  assert.strictEqual(r2.seq, 2, '后续 seq 应连续');
  log.close();
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 2, '只应落盘 2 条成功的');
});

// ══ 附加：append() 连续 seq 不重复（实现期发现的 _nextSeq 问题守门）══
guard('附 连续 append() 的 seq 不重复', () => {
  const f = p('t-extra.jsonl');
  const log = new IntentLog(f, { groupCommitMax: 100 }); log.open(); // 不会触发即时提交
  const seqs = [];
  for (let i = 0; i < 20; i++) seqs.push(log.append({ type: 'x', i }).seq);
  assert.strictEqual(new Set(seqs).size, 20, '20 次 append 必须分配到 20 个不同 seq');
  assert.deepStrictEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1));
  log.close();
});

// ══ 附加：未 open 拒绝写入 ══
guard('附 未 open() 拒绝写入', () => {
  const log = new IntentLog(p('t-noopen.jsonl'));
  assert.throws(() => log.append({ type: 'x' }), /未 open/);
  assert.throws(() => log.appendNow({ type: 'x' }), /未 open/);
});

// ══ 附加：compact 正常路径 ══
guard('附 compact 正常路径（快照落盘 + 日志清空 + seq 归零）', () => {
  const f = p('t-compact.jsonl');
  const snap = p('t-compact.snapshot.json');
  const log = new IntentLog(f); log.open();
  log.appendNow({ type: 'a' });
  log.appendNow({ type: 'b' });
  const r = log.compact([{ seq: 1 }, { seq: 2 }], snap);
  assert.strictEqual(r.ok, true, 'compact 应成功');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(snap, 'utf8')), [{ seq: 1 }, { seq: 2 }]);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '', '日志应被清空');
  assert.strictEqual(log.seq, 0, 'seq 应归零');
  assert.strictEqual(log.logSizeBytes(), 0);
  const nr = log.append({ type: 'c' });
  assert.strictEqual(nr.seq, 1, 'compact 后 seq 从 1 重新开始');
  log.close();
});

console.log(`\nintentLog 契约：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);

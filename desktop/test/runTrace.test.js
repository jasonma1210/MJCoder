// T0-5 回归门禁：runTrace 本地 trace 落盘模块
// 覆盖：JSONL 写入与读回 / runId 清洗防路径穿越 / 未初始化 fail-open / LRU 文件淘汰
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('node:os');
const path = require('path');

const rt = require('../main/runTrace');

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-runtrace-'));

check('未初始化时 append 返回 false 不抛错（fail-open）', () => {
  rt.initRunTrace(null);
  assert.equal(rt.appendTraceEvent('r1', { type: 'tool' }), false);
});

check('初始化后写入 JSONL 并可读回（含 ts 补全）', () => {
  rt.initRunTrace(tmp);
  assert.equal(rt.appendTraceEvent('run-a', { type: 'run_start', model: 'm1' }), true);
  assert.equal(rt.appendTraceEvent('run-a', { type: 'tool', name: 'shell', ms: 12 }), true);
  const evts = rt.readTraceEvents('run-a');
  assert.equal(evts.length, 2);
  assert.equal(evts[0].type, 'run_start');
  assert.equal(evts[1].name, 'shell');
  assert.ok(evts[0].ts > 0, '每条事件应带宿主补全的绝对时间戳');
});

check('恶意 runId 被清洗为安全文件名（防路径穿越）', () => {
  rt.appendTraceEvent('../../etc/evil', { type: 'run_start' });
  const dir = path.join(tmp, 'traces');
  const files = fs.readdirSync(dir);
  // 清洗后的名字允许 '..' 作为字面片段（无分隔符即无法穿越），但绝不允许路径分隔符
  assert.ok(files.every((f) => !f.includes('/') && !f.includes('\\')), `存在带分隔符的文件名: ${files.join(',')}`);
  assert.ok(files.some((f) => f.includes('evil')), '清洗后仍应落盘（不静默丢弃）');
  assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'etc')), '不得写到 traces 目录之外');
});

check('LRU 淘汰：超过上限按文件数收敛', () => {
  const dir = path.join(tmp, 'traces');
  // 造 60 个历史 trace 文件（mtime 递增，模拟先后）
  for (let i = 0; i < 60; i++) {
    const p = path.join(dir, `old-run-${String(i).padStart(3, '0')}.jsonl`);
    fs.writeFileSync(p, '{"type":"run_start"}\n');
    const t = Date.now() - (60 - i) * 1000; // 越早创建 mtime 越旧
    fs.utimesSync(p, new Date(t), new Date(t));
  }
  const removed = rt.evictOldTraces(50);
  assert.ok(removed >= 10, `应至少淘汰 10 个，实际 ${removed}`);
  const left = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  assert.ok(left.length <= 50, `淘汰后应 ≤50 个文件，实际 ${left.length}`);
  // 最旧的应已被删
  assert.ok(!left.includes('old-run-000.jsonl'), 'LRU 应删最旧文件');
});

check('读不存在的 runId 返回空数组（不抛错）', () => {
  assert.deepEqual(rt.readTraceEvents('no-such-run'), []);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nrunTrace: ${pass}/${total} 通过`);
if (pass !== total) process.exitCode = 1;

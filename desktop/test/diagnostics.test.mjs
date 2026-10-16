// T2-5 门禁：本地崩溃/异常聚合（main/diagnostics.js）
// 覆盖：结构化记录（ts/kind/stack）/ 活跃 runId + trace 尾部关联 / 渲染层 IPC 转发收口 /
//      磁盘写失败不二次抛出（兜底路径纪律）/ crashReporter 本地化启动参数。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let pass = 0, total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// ── 临时 userData + electron stub（crashReporter/ipcMain/app）──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-diagnostics-'));
const startedOpts = [];
const ipcHandlers = new Map();
const electronStub = {
  app: { getPath: () => tmp },
  crashReporter: { start: (o) => startedOpts.push(o) },
  ipcMain: { on: (ch, h) => ipcHandlers.set(ch, h) },
};
// diagnostics.js 是 CJS（require('electron')），用 createRequire(DESKTOP/main/) 解析模块 id
const mainRequire = createRequire(path.join(DESKTOP, 'main', 'noop.js'));
require.cache[mainRequire.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true, exports: electronStub };

const diag = require(path.join(DESKTOP, 'main/diagnostics.js'));

// 可控的活跃 run 与 trace 数据源
let activeRuns = [];
const traceData = { 'run-A': Array.from({ length: 30 }, (_, i) => ({ evt: 'tool', i, ts: i })) };
diag.initDiagnostics({ app: electronStub.app, getActiveRunIds: () => activeRuns, readTraceEvents: (r) => traceData[r] || [] });

check('initDiagnostics 注册渲染层转发 IPC（diag:report）', () => {
  assert.ok(ipcHandlers.has('diag:report'), '未注册 diag:report');
});

check('主进程异常落结构化 JSONL（ts/kind/stack）', () => {
  diag.reportError('uncaughtException', new Error('boom-test'));
  const files = fs.readdirSync(path.join(tmp, 'diagnostics')).filter((f) => f.startsWith('crash-') && f.endsWith('.jsonl'));
  assert.equal(files.length, 1, `诊断目录应恰有一个当日文件：${files.join(',')}`);
  const lines = fs.readFileSync(path.join(tmp, 'diagnostics', files[0]), 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[lines.length - 1]);
  assert.equal(rec.kind, 'uncaughtException');
  assert.match(rec.stack, /boom-test/);
  assert.ok(rec.ts, '缺时间戳');
});

check('活跃 run 关联 runId + trace 尾部（回查崩溃前最后在干什么）', () => {
  activeRuns = ['run-A'];
  diag.reportError('unhandledRejection', { stack: 'reject-stack' });
  const file = fs.readdirSync(path.join(tmp, 'diagnostics')).find((f) => f.startsWith('crash-'));
  const lines = fs.readFileSync(path.join(tmp, 'diagnostics', file), 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[lines.length - 1]);
  assert.deepEqual(rec.runIds, ['run-A'], '缺活跃 runId');
  assert.equal(rec.traceTail['run-A'].length, diag.TRACE_TAIL_EVENTS, `trace 尾部应为 ${diag.TRACE_TAIL_EVENTS} 条`);
  assert.equal(rec.traceTail['run-A'][0].i, 10, '尾部应取最后 N 条');
});

check('渲染层错误经 diag:report 收口同一文件', () => {
  activeRuns = [];
  ipcHandlers.get('diag:report')({}, { kind: 'rendererError', message: 'render-boom', stack: 'at Foo' });
  const file = fs.readdirSync(path.join(tmp, 'diagnostics')).find((f) => f.startsWith('crash-'));
  const lines = fs.readFileSync(path.join(tmp, 'diagnostics', file), 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[lines.length - 1]);
  assert.equal(rec.kind, 'rendererError');
  assert.equal(rec.source, 'renderer');
  assert.match(rec.stack, /at Foo/);
});

check('非法 payload 不记录不抛出', () => {
  const before = fs.readdirSync(path.join(tmp, 'diagnostics')).length;
  assert.doesNotThrow(() => ipcHandlers.get('diag:report')({}, null));
  assert.doesNotThrow(() => ipcHandlers.get('diag:report')({}, 'string-payload'));
  assert.equal(fs.readdirSync(path.join(tmp, 'diagnostics')).length, before);
});

check('诊断写入自身失败绝不二次抛出（兜底路径纪律）', () => {
  // 把诊断目录换成一个「文件占位」路径使 mkdir 必失败
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-diag-broken-'));
  fs.writeFileSync(path.join(broken, 'diagnostics'), 'occupied'); // diagnostics 名字被文件占用 → mkdir ENOTDIR/EEXIST
  const d2 = require(path.join(DESKTOP, 'main/diagnostics.js'));
  d2.initDiagnostics({ app: { getPath: () => broken }, getActiveRunIds: () => [], readTraceEvents: () => [] });
  assert.doesNotThrow(() => d2.reportError('uncaughtException', new Error('must-not-crash')));
  fs.rmSync(broken, { recursive: true, force: true });
  // initDiagnostics 是模块单例；恢复主测试用的 userData 目录，以继续验证后续行为。
  diag.initDiagnostics({ app: electronStub.app, getActiveRunIds: () => activeRuns, readTraceEvents: (r) => traceData[r] || [] });
});

check('crashReporter 本地化启动（不上传）', () => {
  const ok = diag.startCrashReporter(electronStub.app);
  assert.equal(ok, true);
  assert.equal(startedOpts.length, 1);
  assert.equal(startedOpts[0].uploadToServer, false, '绝不上传');
  assert.equal(startedOpts[0].submitURL, '', '无上报地址');
});

check('高频同签名异常按计数聚合，首次异常保留且日志容量有界轮转', () => {
  const dir = path.join(tmp, 'diagnostics');
  const file = fs.readdirSync(dir).find((f) => /^crash-.*\.jsonl$/.test(f));
  const full = path.join(dir, file);
  const before = fs.readFileSync(full, 'utf8').trim().split('\n').length;
  for (let i = 0; i < 1000; i += 1) diag.reportError('uncaughtException', { stack: 'Error: repeatable\n    at worker (/app/worker.js:10:2)' });
  const lines = fs.readFileSync(full, 'utf8').trim().split('\n');
  const records = lines.map((line) => JSON.parse(line));
  assert.ok(records.length - before < 20, `重复异常应被压缩为少量记录，新增 ${records.length - before}`);
  assert.ok(records.some((r) => String(r.stack || '').includes('repeatable') && !r.repeatSummary), `第一次异常的原始堆栈必须保留；记录=${JSON.stringify(records.slice(-3))}`);
  assert.ok(records.some((r) => r.repeatSummary && r.repeatCount >= 100), '重复次数达到阈值时写摘要');
  assert.ok(records.every((r) => Buffer.byteLength(JSON.stringify(r)) < 64 * 1024), '单记录大小受限');
  assert.equal(pass, 7, 'previous diagnostic assertions passed');
});

check('日志达到上限后轮转而非静默停止写入', () => {
  const dir = path.join(tmp, 'diagnostics');
  const file = fs.readdirSync(dir).find((f) => /^crash-.*\.jsonl$/.test(f));
  const full = path.join(dir, file);
  // 在 API 前准备一份接近上限的有效 JSONL，再让真实首次异常触发轮转。
  // 生成不同签名的高频异常，每条在单记录上限内，累计触发 5MB 轮转。
  for (let i = 0; i < 1000; i += 1) {
    diag.reportError('filler', { stack: `Error: filler-${i}\\n${'x'.repeat(5000)}` });
  }
  const beforeRotation = fs.statSync(full).size;
  assert.ok(beforeRotation <= diag.MAX_DIAG_FILE_BYTES, '主日志不应超过硬限制');
  diag.reportError('rendererRotationTest', { stack: 'Error: retained-after-rotation' });
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(file));
  assert.ok(files.includes(`${file}.1`), '达到上限时应将旧文件轮转为 .1');
  const contents = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.ok(contents.includes('retained-after-rotation'), '最新首次异常应保留在主日志或轮转文件');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\ndiagnostics: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);

// B 回归门禁：收敛「僵尸 running」运行记录
//
// 真机现场：进程被杀/崩溃后，store.runs 里那条 run 永远停在 status='running'
// （实例 r-1792301285937-1698 在进程早已退出后仍是 running），UI 上「一直运行中」，
// 任务的 last_run_at 也不更新 —— 用户无法判断这次到底跑没跑成。
//
// 运行记录的终点只能由**下次启动**补齐：进程已经不在，没人能写 finished_at。
// 本文件锁：① running → failed（带 interrupted 标记与人话原因）；② 任务卡片字段同步；
// ③ success 记录一个字节都不动；④ 只在确有遗留时才写盘；⑤ 同进程内在跑的 run 不被误判。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); fail++; }
}

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-sched-conv-'));
const STORE = path.join(USER_DATA, 'scheduled-tasks.json');
const noop = () => {};

const Module = require('node:module');
const electronPath = require.resolve('electron');
const stub = new Module(electronPath, null);
stub.filename = electronPath;
stub.loaded = true;
stub.exports = {
  app: { getPath: (n) => (n === 'userData' ? USER_DATA : path.join(USER_DATA, 'docs')), whenReady: () => Promise.resolve(), on: noop },
  ipcMain: { handle: noop, once: noop, on: noop },
};
require.cache[electronPath] = stub;

const scheduledStore = require(path.join(ROOT, 'main', 'scheduledStore.js'));
const scheduler = require(path.join(ROOT, 'main', 'scheduler.js'));

// 写盘计数：用于验证「只在确需收敛时才 persist()」（每次启动都写盘是另一类事故）
let writes = 0;
const origWrite = scheduledStore.write;
scheduledStore.write = (...args) => { writes += 1; return origWrite(...args); };

const INTERRUPTED = '运行被中断（应用在任务执行期间退出），工具调用与输出未收尾，本次数据不可信';
const LIVE_STARTED = '2026-10-16T23:14:45.937Z';
const OK_FINISHED = '2026-10-16T20:01:00.000Z';

function seed(runs, tasks) {
  fs.writeFileSync(STORE, JSON.stringify({ tasks, runs }, null, 2), 'utf8');
  return JSON.parse(fs.readFileSync(STORE, 'utf8'));
}

const TASKS = [
  { id: 't-live', name: '娱乐八卦', prompt: '获取 100 条', schedule: '0 9 * * *', enabled: true, last_status: 'running', last_run_at: LIVE_STARTED, last_result: '' },
  { id: 't-ok', name: '正常任务', prompt: 'x', schedule: '0 9 * * *', enabled: true, last_status: 'success', last_run_at: '2026-10-16T20:00:00.000Z', last_result: 'done' },
];
// 真机那条 run 的原样形态 + 一条正常成功记录 + 一条「任务已被删」的孤儿记录
const RUNS = [
  { id: 'r-1792301285937-1698', task_id: 't-live', trigger: 'scheduled', status: 'running', started_at: LIVE_STARTED, finished_at: null, duration_ms: 0, output: '', error: '', tools: 0 },
  { id: 'r-ok', task_id: 't-ok', trigger: 'scheduled', status: 'success', started_at: '2026-10-16T20:00:00.000Z', finished_at: OK_FINISHED, duration_ms: 60000, output: 'done', error: '', tools: 2 },
  { id: 'r-orphan', task_id: 't-deleted', trigger: 'scheduled', status: 'running', started_at: '2026-10-15T01:00:00.000Z', finished_at: null, output: '', error: '', tools: 0 },
];

seed(RUNS, TASKS);
const writesBefore = writes;
scheduler.loadStore();
const after = JSON.parse(fs.readFileSync(STORE, 'utf8'));

await check('遗留 running → failed，带 interrupted 标记、finished_at 与人话原因', () => {
  const r = after.runs.find((x) => x.id === 'r-1792301285937-1698');
  assert.equal(r.status, 'failed', `status=${r.status}`);
  assert.equal(r.error, INTERRUPTED);
  assert.equal(r.interrupted, true);
  assert.ok(r.finished_at && !Number.isNaN(new Date(r.finished_at).getTime()), 'finished_at 未补');
});

await check('未收尾的 run 不再假装「跑了 0 次工具」：tools 置 null（未知），文案也写明未收尾', () => {
  const r = after.runs.find((x) => x.id === 'r-1792301285937-1698');
  assert.equal(r.tools, null, `tools=${JSON.stringify(r.tools)}（0 会让人以为是「跑了 0 次工具」的可信失败）`);
  assert.match(r.error, /工具调用与输出未收尾/);
});

await check('任务卡片字段同步（last_status/last_result 同一句，last_run_at 保留原始启动时刻）', () => {
  const t = after.tasks.find((x) => x.id === 't-live');
  assert.equal(t.last_status, 'failed');
  assert.equal(t.last_result, INTERRUPTED);
  assert.ok(t.last_result.length <= 500, 'last_result 未截断');
  assert.equal(t.last_run_at, LIVE_STARTED, '丢了原始启动时刻（会让人以为任务刚跑过）');
});

await check('success 记录一个字节都没动（收敛不能反噬正常历史）', () => {
  const r = after.runs.find((x) => x.id === 'r-ok');
  assert.deepEqual(r, RUNS[1]);
  const t = after.tasks.find((x) => x.id === 't-ok');
  assert.equal(t.last_status, 'success');
  assert.equal(t.last_result, 'done');
});

await check('任务已被删的孤儿 run 也收敛（不因找不到任务而抛）', () => {
  const r = after.runs.find((x) => x.id === 'r-orphan');
  assert.equal(r.status, 'failed');
  assert.equal(r.interrupted, true);
});

await check('只写盘一次，且再次 loadStore 不重复写（收敛是幂等的）', () => {
  assert.equal(writes - writesBefore, 1, `写盘 ${writes - writesBefore} 次`);
  const before2 = writes;
  scheduler.loadStore();
  assert.equal(writes - before2, 0, '没有遗留 running 时不该再写盘');
  const again = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  assert.equal(again.runs.find((x) => x.id === 'r-1792301285937-1698').status, 'failed');
});

await check('全是 success 的存储：收敛返回 0 且不写盘', () => {
  seed([RUNS[1]], [TASKS[1]]);
  scheduler.loadStore();
  const before2 = writes;
  assert.equal(scheduler.convergeInterruptedRuns(), 0);
  assert.equal(writes - before2, 0);
});

// ⑤ 同进程内在跑的 run 不能被判死（loadStore 若在运行期间被再调一次）
await check('运行期间的 run 不被误判（同进程 running 集合豁免）', async () => {
  // last_fired 设成「刚刚」：否则 startScheduler 的补跑扫描会为这条过期任务另起一轮，
  // 与本用例的手动运行互斥（running 集合），测到的就不是收敛逻辑了
  seed(RUNS, TASKS.map((t) => ({ ...t, last_fired: new Date().toISOString() })));
  let midFlight = null;
  scheduler.setModel({ providerId: 1, isGlobal: false, baseUrl: 'https://api.test/v1', model: 'test-model', cwd: '' });
  scheduler.startScheduler({
    runAgentTask: async () => {
      scheduler.loadStore(); // 模拟「运行期间再次加载存储」
      midFlight = JSON.parse(fs.readFileSync(STORE, 'utf8')).runs.find((r) => r.status === 'running');
      return { output: '完成', toolCalls: 1 };
    },
    notify: noop,
    taskTimeoutMs: 5000,
  });
  const r = await scheduler.runTask('t-live', 'manual');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(midFlight, '正在执行的 run 被判成了失败（交互会显示「运行被中断」）');
  scheduler.stopScheduler();
});

fs.rmSync(USER_DATA, { recursive: true, force: true });
console.log(`\nscheduled-interrupted-run: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);

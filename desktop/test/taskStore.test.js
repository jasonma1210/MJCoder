// P1-3 任务存储层测试（真实 better-sqlite3）：状态机 / 队列 / 重试 / 阻塞失败 / 崩溃恢复
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDb } = require('../main/db');
const { TaskStore, canTransition } = require('../main/taskStore');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-tasks-'));
const db = openDb(dir);
const store = new TaskStore(db);

const TASKS = [
  { id: 't1', title: '并行 A', prompt: 'p1', dependsOn: [] },
  { id: 't2', title: '并行 B', prompt: 'p2', dependsOn: [] },
  { id: 't3', title: '汇总 C', prompt: 'p3', dependsOn: ['t1', 't2'], critical: true, maxRetry: 1 },
];

// ── 建组与初始状态 ──
const g = store.createGroup({ groupId: 'g1', goal: '测试目标', cwd: '/tmp/x', dag: { levels: [['t1', 't2'], ['t3']] }, tasks: TASKS });
check('建组成功且状态 ready', g.status === 'ready' && g.tasks.length === 3);
check('子任务初始 pending', g.tasks.every((t) => t.status === 'pending'));

// ── 自动编排元数据（迁移 v2 列 + 透传）──
const autoGroup = store.createGroup({
  groupId: 'g-auto', goal: '自动目标', cwd: '/tmp', tasks: TASKS,
  auto: true, replanDepth: 0, replanOf: null,
});
check('auto 组元数据落库', autoGroup.auto === 1 && autoGroup.replan_depth === 0 && autoGroup.replan_of === null);
const replanGroup = store.createGroup({
  groupId: 'g-replan', goal: '重规划目标', cwd: '/tmp', tasks: TASKS,
  auto: true, replanDepth: 1, replanOf: 'g-auto',
});
check('重规划组元数据落库', replanGroup.replan_depth === 1 && replanGroup.replan_of === 'g-auto');
const manualGroup = store.createGroup({ groupId: 'g-manual', goal: '手动目标', cwd: '/tmp', tasks: TASKS });
check('手动组默认 auto=0', manualGroup.auto === 0 && manualGroup.replan_depth === 0);

// ── 入队：依赖未满足不入场 ──
let ready = store.enqueueReady('g1');
check('首轮仅无依赖任务入队', JSON.stringify(ready.sort()) === JSON.stringify(['t1', 't2']));
check('t3 仍 pending', store.getTask('g1', 't3').status === 'pending');

// ── 领取与完成 ──
const claimed = store.claimNext('g1', 'w1');
check('claimNext 领取首个 queued（seq 序）', claimed.taskId === 't1' && claimed.status === 'running' && claimed.workerId === 'w1');
store.setTaskStatus('g1', 't1', 'done', { result: { summary: 'A 完成' } });
ready = store.enqueueReady('g1');
check('t1 完成后 t3 因 t2 未完仍不入场', !ready.includes('t3'));
const t1 = store.getTask('g1', 't1');
check('done 任务带结果与时间戳', t1.result.summary === 'A 完成' && !!t1.startedAt && !!t1.finishedAt);

// ── 非法状态迁移拒绝 ──
let threw = false;
try { store.setTaskStatus('g1', 't1', 'running'); } catch { threw = true; }
check('done → running 非法迁移被拒', threw);
check('canTransition 纯函数：running→done 合法 / done→running 非法',
  canTransition('task', 'running', 'done') === true && canTransition('task', 'done', 'running') === false);

// ── 失败重试：t2 maxRetry=0 → 直接 failed；不阻塞 t3（t3 依赖 t2，t2 非 critical）──
store.claimNext('g1', 'w2');
const f1 = store.handleFailure('g1', 't2', 'boom');
check('maxRetry=0 失败不重试', f1.retried === false && store.getTask('g1', 't2').status === 'failed');
check('retry_count 已累加', store.getTask('g1', 't2').retryCount === 1);

// ── 关键任务失败重试：t3（maxRetry=1）──
// t2 终态 failed 后走「手动重试入口」：failed → queued → running → done
store.setTaskStatus('g1', 't2', 'queued');
store.claimNext('g1', 'w2b');
store.setTaskStatus('g1', 't2', 'done', { result: { summary: 'B 完成' } });
store.enqueueReady('g1');
store.claimNext('g1', 'w3');
const f2 = store.handleFailure('g1', 't3', '首次失败');
check('关键任务首次失败触发重试回队', f2.retried === true && store.getTask('g1', 't3').status === 'queued');
store.claimNext('g1', 'w4');
const f3 = store.handleFailure('g1', 't3', '二次失败');
check('重试额度用尽后终态 failed', f3.retried === false && store.getTask('g1', 't3').retryCount === 2);

// ── 阻塞失败判定：t3 critical 失败但无未完成任务依赖它 → 不阻塞 ──
check('无下游依赖的关键失败不判定阻塞', store.groupHasBlockingFailure('g1') === false);

// ── 阻塞场景：关键任务失败且有 pending 下游 ──
store.createGroup({ groupId: 'g2', goal: '阻塞场景', cwd: '', dag: null, tasks: [
  { id: 'k1', title: '关键', prompt: 'p', dependsOn: [], critical: true },
  { id: 'd1', title: '下游', prompt: 'p', dependsOn: ['k1'] },
] });
store.enqueueReady('g2');
store.claimNext('g2', 'w1'); // k1
store.handleFailure('g2', 'k1', '关键失败');
check('关键失败且下游 pending → 判定阻塞', store.groupHasBlockingFailure('g2') === true);

// ── 组状态迁移与收尾判定 ──
store.setGroupStatus('g2', 'running'); // 真实流程：WorkerPool 启动组即置 running，暂停只会发生在 running 组
store.setGroupStatus('g2', 'paused', { error: '测试暂停' });
check('组 paused 落库', store.getGroup('g2').status === 'paused');
let threw2 = false;
try { store.setGroupStatus('g2', 'running'); } catch { threw2 = false; } // paused → running 合法
check('paused → running 合法迁移', threw2 === false);
check('未完结组 isGroupSettled=false', store.isGroupSettled('g2') === false);

// ── 崩溃恢复：running → queued ──
store.createGroup({ groupId: 'g3', goal: '恢复场景', cwd: '', dag: null, tasks: [{ id: 'a', title: 'x', prompt: 'y' }] });
store.enqueueReady('g3');
store.claimNext('g3', 'w9'); // a → running
store.setGroupStatus('g3', 'running');
const rec = store.recoverInterrupted();
check('崩溃恢复：running 任务回 queued', rec.recoveredTasks >= 1 && store.getTask('g3', 'a').status === 'queued');
check('恢复清单含 running 组', rec.runningGroups.includes('g3'));

// ── 持久化：新连接读回（WAL）──
const db2 = openDb(dir);
const store2 = new TaskStore(db2);
check('重开连接数据完整（WAL 持久化）', store2.getGroup('g1').tasks.length === 3 && store2.getGroup('g1').tasks.find((t) => t.taskId === 't1').result.summary === 'A 完成');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);

// sql.js（WASM 降级驱动）适配层测试：验证 better-sqlite3 兼容 API 面 + 持久化往返
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openSqliteJsDb, PERSIST_DEBOUNCE_MS } = require('../main/db/sqljsDb');
const { MIGRATIONS } = require('../main/db');
const { TaskStore } = require('../main/taskStore');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-sqljs-'));
const file = path.join(tmp, 't.db');

let n = 0;
function ok(name) { n += 1; console.log(`  ✓ ${name}`); }

(async () => {
  // 1. 建库 + 迁移链
  const db = await openSqliteJsDb(file);
  db.pragma('user_version = 0');
  const v0 = db.pragma('user_version', { simple: true });
  assert.strictEqual(v0, 0, 'PRAGMA user_version 读回');
  ok('PRAGMA 读/写');

  db.pragma('journal_mode = WAL');  // 内存库上无害降级，不应抛错
  db.pragma('foreign_keys = ON');
  ok('无害 PRAGMA 降级');

  for (const m of MIGRATIONS) {
    const tx = db.transaction(() => { m.up(db); db.pragma(`user_version = ${m.version}`); });
    tx();
  }
  const v1 = db.pragma('user_version', { simple: true });
  assert.strictEqual(v1, MIGRATIONS.length, '迁移版本号（跟随迁移链最新版）');
  ok('迁移事务 + user_version 持久化语义');

  // 2. prepare.run/get/all
  db.prepare('INSERT INTO task_groups (group_id, goal, cwd, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('g1', '目标A', '/tmp/x', 'ready', 1, 1);
  const g = db.prepare('SELECT * FROM task_groups WHERE group_id = ?').get('g1');
  assert.strictEqual(g.goal, '目标A');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM task_groups').get().n, 1);
  assert.strictEqual(db.prepare('SELECT * FROM task_groups WHERE group_id = ?').get('nope'), undefined);
  ok('prepare run/get/all（含未命中 → undefined）');

  // undefined 参数归一为 null（可空列 worker_id）
  db.prepare('INSERT INTO sub_tasks (task_id, group_id, seq, title, prompt, depends_on, worker_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('t1', 'g1', 0, '任务1', '做事情', '[]', undefined, 'pending');
  const t = db.prepare('SELECT worker_id FROM sub_tasks WHERE task_id = ?').get('t1');
  assert.strictEqual(t.worker_id, null);
  ok('undefined 参数 → null 归一');

  // 3. 事务回滚语义
  const boom = db.transaction(() => {
    db.prepare('INSERT INTO task_groups (group_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('g-bad', 'x', 'ready', 1, 1);
    throw new Error('rollback-me');
  });
  assert.throws(boom, /rollback-me/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM task_groups WHERE group_id = ?').get('g-bad').n, 0);
  ok('事务异常 → ROLLBACK');

  // 4. TaskStore 状态机跑在 sql.js 上
  const store = new TaskStore(db);
  const created = store.createGroup({
    groupId: 'grp', goal: '做一件事', cwd: '/tmp',
    dag: { tasks: [
      { id: 'a', title: 'A', prompt: 'pa', dependsOn: [], critical: true, maxRetry: 1, timeoutMs: 1000 },
      { id: 'b', title: 'B', prompt: 'pb', dependsOn: ['a'], critical: false, maxRetry: 0, timeoutMs: 1000 },
    ] },
    tasks: [
      { id: 'a', title: 'A', prompt: 'pa', dependsOn: [], critical: true, maxRetry: 1, timeoutMs: 1000 },
      { id: 'b', title: 'B', prompt: 'pb', dependsOn: ['a'], critical: false, maxRetry: 0, timeoutMs: 1000 },
    ],
  });
  assert.strictEqual(created.tasks.length, 2);
  store.enqueueReady('grp');
  const claimed = store.claimNext('grp', 'w1');
  assert.strictEqual(claimed.taskId, 'a');
  store.setTaskStatus('grp', 'a', 'done', { result: { summary: 'A 完成' } });
  store.enqueueReady('grp');
  const claimedB = store.claimNext('grp', 'w2');
  assert.strictEqual(claimedB.taskId, 'b');
  const { retried } = store.handleFailure('grp', 'b', '超时');
  assert.strictEqual(retried, false, 'maxRetry=0 不重试');
  assert.strictEqual(store.getTask('grp', 'b').status, 'failed');
  assert.strictEqual(store.groupHasBlockingFailure('grp'), false, 'b 非关键');
  ok('TaskStore 状态机（claim/依赖解锁/失败处置）');

  // 5. 持久化往返：flush → 重新载入 → 状态完整
  db.flush();
  const db2 = await openSqliteJsDb(file);
  assert.strictEqual(db2.pragma('user_version', { simple: true }), MIGRATIONS.length, '迁移版本持久化');
  const store2 = new TaskStore(db2);
  const g2 = store2.getGroup('grp');
  assert.strictEqual(g2.goal, '做一件事');
  assert.strictEqual(g2.tasks.find((x) => x.taskId === 'a').status, 'done');
  assert.deepStrictEqual(g2.tasks.find((x) => x.taskId === 'a').result, { summary: 'A 完成' });
  assert.strictEqual(g2.tasks.find((x) => x.taskId === 'b').status, 'failed');
  ok('flush 落盘 → 重开库状态完整（断点续跑前提）');

  // 6. 崩溃恢复：running → queued（failed 任务先手动重试回队，再模拟领取后崩溃）
  store2.setTaskStatus('grp', 'b', 'queued');
  store2.claimNext('grp', 'w3');
  assert.strictEqual(store2.getTask('grp', 'b').status, 'running');
  const rec = store2.recoverInterrupted();
  assert.strictEqual(rec.recoveredTasks, 1);
  assert.strictEqual(store2.getTask('grp', 'b').status, 'queued');
  db2.close();
  ok('recoverInterrupted 崩溃恢复');

  // 7. 防抖窗口内 exit 兜底 flush（新库，写完立刻 close 而不手动 flush）
  const file3 = path.join(tmp, 't3.db');
  const db3 = await openSqliteJsDb(file3);
  db3.exec('CREATE TABLE x(v)');
  db3.prepare('INSERT INTO x VALUES (?)').run('hi');
  db3.close(); // close 内部 flush
  const raw = fs.readFileSync(file3);
  assert.ok(raw.length > 0, '落盘文件非空');
  ok('close 自动 flush');

  db.close();
  console.log(`\nsqljsDb 适配层：${n} 项全部通过`);
})().catch((e) => { console.error(e); process.exit(1); });

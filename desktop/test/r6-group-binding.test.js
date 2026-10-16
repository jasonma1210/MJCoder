// R6.1 任务组绑定会话 + 删除契约（2026-10-16，用户实测反馈）：
//   1) threadId 随组持久化（重开连接可读）；
//   2) deleteGroup：终态/暂停组可删，事务级联清理（sub_tasks + side_effects）；
//   3) fail-closed：running 组拒删（先取消再删）；
//   4) 删除后组不存在（listGroups 不再返回）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const { TaskStore } = require('../main/taskStore');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-r6-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const store = new TaskStore(db);

  // 1) threadId 持久化
  const g1 = store.createGroup({
    groupId: 'g-thread', goal: '会话绑定组', cwd: '/tmp/proj',
    dag: null, tasks: [{ id: 'a', title: 'x', prompt: 'p' }],
    threadId: 'thread-abc-123',
  });
  check('createGroup 接收 threadId', g1.thread_id === 'thread-abc-123');
  const db2 = await openDbAsync(path.join(dir, 'reopen'), { driver: 'sqljs' });
  // 重新走一遍迁移 + 写入读回验证持久化（sql.js 内存库，直接再查原库）
  const raw = db.prepare('SELECT thread_id FROM task_groups WHERE group_id = ?').get('g-thread');
  check('thread_id 已落库', raw && raw.thread_id === 'thread-abc-123');

  // 2) running 组拒删（fail-closed）
  const g2 = store.createGroup({
    groupId: 'g-running', goal: '运行中组', cwd: '',
    dag: null, tasks: [{ id: 'a', title: 'x', prompt: 'p' }],
    threadId: 'thread-abc-123',
  });
  store.enqueueReady('g-running');
  store.claimNext('g-running', 'w1');
  store.setGroupStatus('g-running', 'running');
  const deny = store.deleteGroup('g-running');
  check('running 组拒删（先取消再删）', deny.ok === false && /取消/.test(String(deny.error)));
  check('running 组仍在', !!store.getGroup('g-running'));

  // 3) 副作用账本级联：g2 挂账后取消 → 删除 → 账本一并清除
  store.markEffectUncertain('g-running', 'a');
  store.setGroupStatus('g-running', 'paused');
  const del2 = store.deleteGroup('g-running');
  check('paused 组可删', del2.ok === true);
  check('组删除后 listGroups 不再返回', !store.listGroups({}).some((g) => g.group_id === 'g-running'));
  const seCount = db.prepare('SELECT COUNT(*) AS n FROM side_effects WHERE group_id = ?').get('g-running').n;
  check('副作用账本级联清除', seCount === 0);
  const stCount = db.prepare('SELECT COUNT(*) AS n FROM sub_tasks WHERE group_id = ?').get('g-running').n;
  check('子任务级联清除', stCount === 0);

  // 4) done 组可删；不存在组返回明确错误
  store.createGroup({ groupId: 'g-done', goal: '已完成组', cwd: '', dag: null, tasks: [] });
  store.setGroupStatus('g-done', 'running'); // 状态机：ready → running → done
  store.setGroupStatus('g-done', 'done');
  check('done 组可删', store.deleteGroup('g-done').ok === true);
  check('不存在组返回错误', store.deleteGroup('g-done').ok === false);

  db2.close();
  try { if (db.close) db.close(); } catch { /* sql.js 无需 close 也兼容 */ }
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n──── R6.1 组绑定会话/删除契约汇总：通过 ${pass} · 失败 ${fail} ────`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });

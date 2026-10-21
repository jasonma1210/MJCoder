// M5 / T5-2 军团消息总线测试（sql.js 驱动）：
//   落库与查询 / seq 团队内单调 / run 隔离 / G4 体积闸（超限回落 refs-only）/ refs 归一 / 重启恢复
//
// 设计依据（v1.1 §5 表 3、§2 G4、§11 验收行）：
//   · 只传摘要与引用（summary + refs），不搬运全文；
//   · 超限消息被闸拒绝并回落 refs-only（丢 payload、截断 summary）；
//   · seq 团队内单调 = 渲染与注入顺序的单一事实来源。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const {
  TeamStore, MESSAGE_SUMMARY_MAX, MESSAGE_TOTAL_MAX, MESSAGE_REFS_MAX, MESSAGE_REF_MAX, SYSTEM_RUN_ID,
  normalizeRefs,
} = require('../main/teamStore');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-msgbus-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const store = new TeamStore(db);

  const team = store.createTeam({ name: '消息组', description: 'x', projectPath: '/proj/m' });

  // ── 落库与字段 ──
  const r1 = store.appendMessage({
    teamId: team.id, runId: 'run-1', fromMemberId: 'm-a', toMemberId: 'm-b',
    kind: 'assign', summary: '把首页重构任务派给写手', refs: ['file://src/App.tsx', 'task:1'],
    payload: { note: 'short' },
  });
  check('appendMessage 返回 message', !!r1.message && r1.message.id.startsWith('msg'));
  check('未超限时 gated=false', r1.gated === false && r1.reason === null);
  check('字段映射正确（kind/from/to/run）',
    r1.message.kind === 'assign' && r1.message.fromMemberId === 'm-a'
    && r1.message.toMemberId === 'm-b' && r1.message.runId === 'run-1');
  check('摘要原样落库', r1.message.summary === '把首页重构任务派给写手');
  check('refs 落库为数组', JSON.stringify(r1.message.refs) === JSON.stringify(['file://src/App.tsx', 'task:1']));
  check('payload 未超限时保留', !!r1.message.payload && r1.message.payload.note === 'short');
  check('第一条消息 seq=1', r1.message.seq === 1);
  check('getMessage 可回读', store.getMessage(r1.message.id)?.summary === r1.message.summary);

  // ── kind 枚举 fail-closed ──
  const badKind = store.appendMessage({ teamId: team.id, kind: 'bogus', summary: 'x' });
  check('非法 kind 回落 system', badKind.message.kind === 'system');

  // ── seq 团队内单调 ──
  const s2 = store.appendMessage({ teamId: team.id, kind: 'report', summary: '第二' });
  const s3 = store.appendMessage({ teamId: team.id, kind: 'handoff', summary: '第三' });
  check('seq 团队内单调递增', s2.message.seq === 3 && s3.message.seq === 4, `seq=${s2.message.seq},${s3.message.seq}`);
  const other = store.createTeam({ name: '别的组', description: 'y', projectPath: '/proj/m' });
  const o1 = store.appendMessage({ teamId: other.id, kind: 'report', summary: '跨团队从 1 开始' });
  check('seq 按团队各自计数（不跨团队串号）', o1.message.seq === 1);

  // ── G4 体积闸：summary 超限 ⇒ 回落 refs-only（丢 payload、截断 summary）──
  const big = 'a'.repeat(MESSAGE_SUMMARY_MAX + 500);
  const g1 = store.appendMessage({
    teamId: team.id, runId: 'run-2', kind: 'report', summary: big,
    refs: ['file://docs/report.md'], payload: { huge: 'x'.repeat(1000) },
  });
  check('summary 超限被闸（gated=true）', g1.gated === true && typeof g1.reason === 'string');
  check('回落 refs-only：payload 被丢弃', g1.message.payload === null);
  check('回落 refs-only：summary 被截断到硬上限',
    g1.message.summary.length === MESSAGE_SUMMARY_MAX, `len=${g1.message.summary.length}`);
  check('回落仍保留引用（只留摘要+引用）',
    JSON.stringify(g1.message.refs) === JSON.stringify(['file://docs/report.md']));

  // ── G4 体积闸：合计超限（summary 未超但 +payload 超）⇒ 同样回落 ──
  const g2 = store.appendMessage({
    teamId: team.id, runId: 'run-2', kind: 'report', summary: 'ok',
    payload: { blob: 'y'.repeat(MESSAGE_TOTAL_MAX) },
  });
  check('合计体积超限被闸', g2.gated === true && g2.message.payload === null);
  check('合计闸下 summary 未超则原样保留', g2.message.summary === 'ok');

  // ── refs 归一：非字符串/空串被丢弃、超长截断、条数封顶 ──
  const refsInput = ['a'.repeat(MESSAGE_REF_MAX + 50), '', '   ', null, 123, {}, 'ok-ref'];
  const N = normalizeRefs(refsInput);
  check('refs 丢弃非字符串条目', N.every((x) => typeof x === 'string'));
  check('refs 丢弃空串/空白条目', !N.includes('') && N.every((x) => x.trim() !== ''));
  check('refs 超长条目被截断到上限', N[0].length === MESSAGE_REF_MAX);
  const many = store.appendMessage({
    teamId: team.id, kind: 'artifact_ref', summary: 'multi',
    refs: Array.from({ length: MESSAGE_REFS_MAX + 5 }, (_, i) => `ref-${i}`),
  });
  check(`refs 条数封顶 ${MESSAGE_REFS_MAX}`, many.message.refs.length === MESSAGE_REFS_MAX);

  // ── run 隔离 ──
  const run1 = store.listMessages({ teamId: team.id, runId: 'run-1' });
  check('按 run 过滤只取该 run 消息', run1.length === 1 && run1[0].runId === 'run-1');
  const run2 = store.listMessages({ teamId: team.id, runId: 'run-2' });
  check('run-2 消息不含 run-1', run2.every((m) => m.runId === 'run-2') && run2.length === 2);
  const sysMsg = store.appendMessage({
    teamId: team.id, runId: SYSTEM_RUN_ID, kind: 'system', summary: 'teamCreated',
    payload: { sys: 'teamCreated' },
  });
  const noRun = store.listMessages({ teamId: team.id, runId: SYSTEM_RUN_ID });
  check('系统广播 run_id 为空串（旁路，无 run 归属）', sysMsg.message.runId === '');
  check('按 run 过滤时系统广播不进该 run 注入（run 隔离生效）',
    !run1.some((m) => m.id === sysMsg.message.id));
  check('runId 传空串 = 不做 run 过滤（取全量，供时间轴）',
    noRun.some((m) => m.id === sysMsg.message.id));
  const all = store.listMessages({ teamId: team.id });
  check('不传 runId 时取全量（按 seq 升序）',
    all.length >= 6 && all.every((m, i) => i === 0 || m.seq > all[i - 1].seq));
  check('全量列表不含别的团队消息', all.every((m) => m.teamId === team.id));

  // ── afterSeq 增量 ──
  const after = store.listMessages({ teamId: team.id, afterSeq: s2.message.seq });
  check('afterSeq 只取更新的消息', after.every((m) => m.seq > s2.message.seq) && after.length > 0);
  check('afterSeq 含 system 广播（不因 run 空被排除）', after.some((m) => m.id === sysMsg.message.id));

  // ── 非法入参 ──
  let threw = false;
  try { store.appendMessage({ summary: 'no team' }); } catch { threw = true; }
  check('缺 teamId 被拒', threw);
  threw = false;
  try { store.appendMessage({ teamId: 'no-such-team', summary: 'x' }); } catch { threw = true; }
  check('团队不存在被拒（外键语义在写入前拦下）', threw);
  threw = false;
  try { store.listMessages({}); } catch { threw = true; }
  check('listMessages 缺 teamId 被拒', threw);

  // ── 重启恢复：flush 落盘 → 同目录重开 ──
  db.flush();
  const db2 = await openDbAsync(dir, { driver: 'sqljs' });
  const store2 = new TeamStore(db2);
  const reloaded = store2.listMessages({ teamId: team.id });
  check('重启后消息仍在', reloaded.length === all.length, `before=${all.length} after=${reloaded.length}`);
  check('重启后 seq 保持单调', reloaded.every((m, i) => i === 0 || m.seq > reloaded[i - 1].seq));
  const nextSeq = store2.appendMessage({ teamId: team.id, kind: 'report', summary: '重启后续写' });
  check('重启后 seq 从既有最大值续增',
    nextSeq.message.seq === reloaded[reloaded.length - 1].seq + 1, `seq=${nextSeq.message.seq}`);

  // ── B-14：容量闸 + 保留期（写入即维护，无需独立定时器）──
  {
    const { TEAM_MESSAGES_MAX_PER_TEAM, TEAM_MESSAGES_TTL_MS } = require('../main/teamStore');
    // 直接批量灌入（避免 1000 次 append 的 O(n²) 清理开销），再由一次 append 触发维护。
    const ins = store2.db.prepare(`INSERT INTO team_messages
      (id, team_id, run_id, seq, from_member_id, to_member_id, kind, summary, refs_json, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < TEAM_MESSAGES_MAX_PER_TEAM + 5; i++) {
      ins.run(`bulk-${i}`, team.id, 'run-bulk', 1000 + i, null, null, 'system', `s${i}`, '[]', null, Date.now());
    }
    store2.appendMessage({ teamId: team.id, kind: 'system', summary: 'triggers-prune' });
    const cnt = Number(store2.db.prepare('SELECT COUNT(*) AS n FROM team_messages WHERE team_id = ?').get(team.id)?.n);
    check('B-14 每团队消息数不超过容量上限', cnt === TEAM_MESSAGES_MAX_PER_TEAM, `count=${cnt}`);
    const maxSeq = Number(store2.db.prepare('SELECT MAX(seq) AS n FROM team_messages WHERE team_id = ?').get(team.id)?.n);
    check('B-14 淘汰最旧而非最新（seq 最大值保留）', maxSeq >= 1000 + TEAM_MESSAGES_MAX_PER_TEAM - 1, `maxSeq=${maxSeq}`);

    // TTL：把一条消息改成 31 天前，再 append 一次即被清理
    store2.db.prepare('UPDATE team_messages SET created_at = ? WHERE id = ?')
      .run(Date.now() - TEAM_MESSAGES_TTL_MS - 1000, 'bulk-1000');
    store2.appendMessage({ teamId: team.id, kind: 'system', summary: 'triggers-ttl' });
    const stale = store2.db.prepare('SELECT id FROM team_messages WHERE id = ?').get('bulk-1000');
    check('B-14 超过保留期的消息被清理', !stale);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

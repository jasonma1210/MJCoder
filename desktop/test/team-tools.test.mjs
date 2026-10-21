// M5 / T5-8：军团协同工具的门禁（§13.5）。
//
// 覆盖四层，都是「读源码看不出来、只有跑起来才会错」的判据：
//   ① 条件注册：无团队上下文时四个键**整体不出现**（否则普通会话/定时任务也能看到 schema）；
//   ② 安全边界：fromMemberId / runId 取自上下文（模型传参不可伪造）、toMemberId 必须同团队、
//      kind 拒绝 system、归档团队只读；
//   ③ 事实透传：G4 体积闸的 gated/reason 必须如实回报；team_wait 必须复用 waitTask 并透传 waiting；
//   ④ 装配静态断言：TEAM_TOOLS 只含 4 个协作工具（控制层不接）、提示词与 schema 共用同一门控、
//      超时与通道均已登记。
//
// 为什么 ② 值得逐条测：这几个字段一旦漏校验，成员就能冒充统筹发号施令、或跨团队串消息，
// 而界面上看不出任何异常——只有把「模型传了也无效」钉成断言才能防住。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const { createTeamToolHandlers, MODEL_MESSAGE_KINDS } = require(path.join(DESKTOP, 'main/teamTools.js'));
const { scheduledToolHandlers } = require(path.join(DESKTOP, 'main/scheduledTools.js'));
const { TOOL_CHANNELS } = require(path.join(DESKTOP, 'main/engineProcess/registry.js'));
const { TOOL_LEVEL, READONLY_TOOLS, REVERSIBILITY, toolLevel, reversibilityOf } =
  require(path.join(DESKTOP, 'main/approval.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── 测试夹具 ──

const CTX = { teamId: 'team-1', runId: 'run-1', taskId: 't2', memberId: 'm-dev' };

function makeTeam(over = {}) {
  return {
    id: 'team-1',
    name: '前端组',
    description: '补齐桌面端',
    leadMemberId: 'm-lead',
    archivedAt: null,
    members: [
      { id: 'm-lead', name: '统筹A', roleKind: 'lead', enabled: true, toolNames: ['shell'], systemPrompt: 'SECRET-LEAD' },
      { id: 'm-dev', name: '开发B', roleKind: 'member', enabled: true, toolNames: [], systemPrompt: 'SECRET-DEV' },
    ],
    ...over,
  };
}

/** 记录调用并按需返回的假依赖 */
function makeDeps({ team = makeTeam(), tasks = [], msgResult, waitResult, throwOn } = {}) {
  const calls = { postMessage: [], waitTask: [] };
  const deps = {
    getTeamStore: () => ({
      getTeam(id) {
        if (throwOn === 'getTeam') throw new Error('boom');
        return id === (team && team.id) ? team : null;
      },
    }),
    getTaskStore: () => ({
      listTasks(groupId) {
        if (throwOn === 'listTasks') throw new Error('boom');
        return tasks.filter((t) => (t.groupId || 'run-1') === groupId);
      },
    }),
    postMessage(input) {
      calls.postMessage.push(input);
      return msgResult === undefined
        ? { message: { id: 'msg-1', seq: 7 }, gated: false, reason: null }
        : msgResult;
    },
    waitTask(runId, taskId, ids, opts) {
      calls.waitTask.push({ runId, taskId, ids, opts });
      return waitResult !== undefined
        ? waitResult
        : { ok: true, waiting: true, waitingOn: ids, deadlineAt: 123 };
    },
  };
  return { deps, calls };
}

function build(ctx = CTX, opts = {}) {
  const { deps, calls } = makeDeps(opts);
  const h = createTeamToolHandlers({ teamContext: ctx, ...deps });
  return { h, calls, deps };
}

// ── ① 条件注册：无团队上下文 ⇒ 四个键整体不出现 ──
// prTools 是构造期立即求值的（withCtx(prTools.prView)），必须给桩，否则本套件自己先炸。
const prStub = { prView() {}, prDiff() {}, prReview() {}, prComment() {} };
{
  const base = scheduledToolHandlers({ prTools: prStub });
  const keys = ['teamListMembers', 'teamSendMessage', 'teamBoard', 'teamWait'];
  check('无 teamTools 时不注册协同工具', keys.every((k) => !(k in base)));

  const { h } = build();
  const withTeam = scheduledToolHandlers({ prTools: prStub, teamTools: h });
  check('注入 teamTools 后四键全部出现', keys.every((k) => typeof withTeam[k] === 'function'));
  check('四键与实现同一引用（无中间包装丢失上下文）',
    keys.every((k) => withTeam[k] === h[k]));
}

// ── ② 无上下文 / 团队异常：结构化错误而非抛异常 ──
{
  for (const ctx of [null, {}, { teamId: 'x' }]) {
    const h = createTeamToolHandlers({ teamContext: ctx, ...makeDeps().deps });
    const rs = [h.teamListMembers(), h.teamSendMessage({ summary: 'x' }), h.teamBoard(), h.teamWait({ taskIds: ['t1'] })];
    check(`上下文缺失（${JSON.stringify(ctx)}）四个工具均返回结构化错误`,
      rs.every((r) => r.ok === false && /团队上下文/.test(r.error)));
  }

  const { h } = build(CTX, { team: null });
  check('团队不存在 → 结构化错误', /团队不存在/.test(h.teamListMembers().error));

  const { h: hArch } = build(CTX, { team: makeTeam({ archivedAt: 1700000000000 }) });
  check('归档团队只读：list 被拒', /已归档/.test(hArch.teamListMembers().error));
  check('归档团队只读：send 被拒', /已归档/.test(hArch.teamSendMessage({ summary: 'x' }).error));

  const { h: hBoom } = build(CTX, { throwOn: 'getTeam' });
  check('存储异常 → 结构化错误不抛出', /读取团队失败/.test(hBoom.teamListMembers().error));
}

// ── ③ team_list_members：投影字段白名单（不下发 system_prompt） ──
{
  const { h } = build();
  const r = h.teamListMembers();
  check('名册成功且带团队摘要', r.ok === true && r.team.teamId === 'team-1' && r.team.name === '前端组');
  check('me / leadMemberId 取自团队与上下文', r.me === 'm-dev' && r.leadMemberId === 'm-lead');
  check('成员数正确', r.members.length === 2);

  const m = r.members.find((x) => x.memberId === 'm-dev');
  assert.ok(m);
  check('成员投影只含协作字段',
    Object.keys(m).sort().join(',') === 'enabled,isLead,memberId,name,roleKind,toolNames');
  check('统筹标记正确', r.members.find((x) => x.memberId === 'm-lead').isLead === true && m.isLead === false);
  check('不下发 system_prompt（避免人格串味/体积）',
    !JSON.stringify(r).includes('SECRET-LEAD') && !JSON.stringify(r).includes('SECRET-DEV'));
}

// ── ④ team_send_message：安全边界 + G4 透传 ──
{
  const { h, calls } = build();
  check('summary 必填', /summary 必填/.test(h.teamSendMessage({}).error));

  const sys = h.teamSendMessage({ summary: 'x', kind: 'system' });
  check('kind=system 被拒（系统事实不允许模型伪造）', sys.ok === false && /kind 非法/.test(sys.error));

  const cross = h.teamSendMessage({ summary: 'x', toMemberId: 'm-other-team' });
  check('跨团队 toMemberId 被拒', cross.ok === false && /不在本团队名册/.test(cross.error));

  const ok = h.teamSendMessage({
    summary: '  接口已就绪  ',
    kind: 'report',
    toMemberId: 'm-lead',
    fromMemberId: 'm-lead', // 伪造统筹身份，必须被忽略
    runId: 'run-forged',    // 伪造 run，必须被忽略
    payload: { a: 1 },
    refs: ['file:///x'],
  });
  check('合法消息写入成功', ok.ok === true && ok.messageId === 'msg-1' && ok.seq === 7);
  const sent = calls.postMessage[0];
  check('fromMemberId 取自上下文（伪造无效）', sent.fromMemberId === 'm-dev');
  check('runId 取自上下文（伪造无效）', sent.runId === 'run-1');
  check('summary 去空白、kind/to 透传', sent.summary === '接口已就绪' && sent.kind === 'report' && sent.toMemberId === 'm-lead');

  // 广播：空 toMemberId ⇒ null；未传 kind ⇒ 默认 report
  const { h: h2, calls: c2 } = build();
  h2.teamSendMessage({ summary: 'broadcast' });
  check('空 toMemberId 表示广播（传 null）', c2.postMessage[0].toMemberId === null);
  check('未传 kind 默认 report', c2.postMessage[0].kind === 'report');

  // G4 体积闸：gated 必须如实回报，且带 note 告知 payload 已丢弃
  const { h: h3 } = build(CTX, {
    msgResult: { message: { id: 'msg-2', seq: 8 }, gated: true, reason: 'payload 超 4000 字节' },
  });
  const g = h3.teamSendMessage({ summary: 'x', payload: { big: 'y' } });
  check('G4 gated 透传', g.ok === true && g.gated === true);
  check('gated 时 note 说明 payload 已丢弃', typeof g.note === 'string' && /摘要/.test(g.note) && /4000/.test(g.note));

  const { h: h4 } = build(CTX, { msgResult: null });
  check('总线不可用 → 结构化错误', /消息总线不可用/.test(h4.teamSendMessage({ summary: 'x' }).error));

  const { h: h5 } = build(CTX, { msgResult: undefined });
  const throwing = createTeamToolHandlers({
    teamContext: CTX, ...makeDeps().deps,
    postMessage: () => { throw new Error('bus down'); },
  });
  check('总线抛错 → 结构化错误不打断整轮', /写入消息总线失败/.test(throwing.teamSendMessage({ summary: 'x' }).error));
  check('正常实例不受上面抛错影响', h5.teamSendMessage({ summary: 'y' }).ok === true);
}

// ── ⑤ team_board：只读投影（不含 prompt/result）+ 状态计数 ──
{
  const tasks = [
    { taskId: 't1', title: 'A', status: 'done', ownerMemberId: 'm-dev', dependsOn: [], critical: false, prompt: 'PROMPT-1', result: 'RESULT-1' },
    { taskId: 't2', title: 'B', status: 'running', ownerMemberId: 'm-dev', dependsOn: ['t1'], critical: true, prompt: 'PROMPT-2' },
    { taskId: 't3', title: 'C', status: 'weird', dependsOn: [] },
    { taskId: 't4', title: 'D', status: 'queued' },
  ];
  const { h } = build(CTX, { tasks });
  const r = h.teamBoard();
  check('看板成功且返回全部任务', r.ok === true && r.tasks.length === 4 && r.runId === 'run-1');
  check('任务投影只含看板字段',
    Object.keys(r.tasks[0]).sort().join(',') === 'critical,dependsOn,ownerMemberId,status,taskId,title');
  check('不下发 prompt/result（大结果不回流上下文）',
    !JSON.stringify(r).includes('PROMPT-') && !JSON.stringify(r).includes('RESULT-'));
  check('依赖与关键标记透传', r.tasks[1].dependsOn[0] === 't1' && r.tasks[1].critical === true);
  check('状态计数正确且未知状态不计入已知桶',
    r.counts.total === 4 && r.counts.done === 1 && r.counts.running === 1
    && r.counts.queued === 1 && r.counts.waiting === 0);

  const { h: hBoom } = build(CTX, { throwOn: 'listTasks' });
  check('看板读取异常 → 结构化错误', /读取看板失败/.test(hBoom.teamBoard().error));
}

// ── ⑥ team_wait：复用 waitTask 唯一入口 + waiting 语义如实告知 ──
{
  const { h, calls } = build();
  check('taskIds 必填', /taskIds 必填/.test(h.teamWait({}).error));

  const r = h.teamWait({ taskIds: ['t3', ' t4 ', ''], timeoutMs: 90000 });
  check('waitTask 以 run/task/依赖登记（去重去空、保留顺序）',
    calls.waitTask.length === 1
    && calls.waitTask[0].runId === 'run-1' && calls.waitTask[0].taskId === 't2'
    && calls.waitTask[0].ids.join(',') === 't3,t4');
  check('timeoutMs 透传', calls.waitTask[0].opts.timeoutMs === 90000);
  check('waiting=true 且提示将让出槽位',
    r.ok === true && r.waiting === true && /让出并发槽位/.test(r.note));

  const { h: hSettled } = build(CTX, {
    waitResult: { ok: true, waiting: false, reason: 'deps_already_settled', waitingOn: ['t3'], deadlineAt: null },
  });
  const s = hSettled.teamWait({ taskIds: ['t3'] });
  check('依赖已就绪 ⇒ waiting=false 且提示可继续', s.ok === true && s.waiting === false && /无需挂起/.test(s.note));

  const { h: hBad } = build(CTX, {
    waitResult: { ok: false, error: '任务不能等待自身', waiting: false, waitingOn: [], deadlineAt: null },
  });
  const b = hBad.teamWait({ taskIds: ['t2'] });
  check('建边被拒 ⇒ 如实返回原因（不静默）', b.ok === false && /不能等待自身/.test(b.error) && b.waiting === false);

  const throwing = createTeamToolHandlers({
    teamContext: CTX, ...makeDeps().deps,
    waitTask: () => { throw new Error('pool down'); },
  });
  check('等待通道异常 → 结构化错误', /登记等待失败/.test(throwing.teamWait({ taskIds: ['t3'] }).error));
}

// ── ⑦ 装配静态断言：范围（只接协作层）、门控、登记 ──
{
  const coreSrc = fs.readFileSync(path.join(DESKTOP, 'agent-core/index.js'), 'utf8');
  const statusSrc = fs.readFileSync(path.join(DESKTOP, 'main/approval.js'), 'utf8');

  check('TEAM_TOOLS 只含 4 个协作工具',
    ['team_list_members', 'team_send_message', 'team_board', 'team_wait']
      .every((n) => coreSrc.includes(`name: '${n}'`)));
  check('控制层 4 工具未进 schema（编制变更归用户主权 + 无人值守无审批）',
    ['team_create_member', 'team_update_member', 'team_remove_member', 'team_interrupt']
      .every((n) => !coreSrc.includes(n) && !statusSrc.includes(n)));

  // 提示词段与 schema 必须同一门控：只给成员任务，且不被 customSystemPrompt 挤掉
  const gateCount = (coreSrc.match(/teamContext && !customTools/g) || []).length;
  check('提示词与 schema 共用 teamContext 门控（≥2 处）', gateCount >= 2, `命中 ${gateCount} 处`);
  check('TEAM_PROMPT_SECTION 存在且声明身份由系统注入',
    coreSrc.includes('TEAM_PROMPT_SECTION') && /发送者身份与 run 归属由系统注入/.test(coreSrc));

  check('四个工具名 → 通道映射齐全',
    ['team_list_members: \'teamListMembers\'', 'team_send_message: \'teamSendMessage\'',
      'team_board: \'teamBoard\'', 'team_wait: \'teamWait\''].every((s) => coreSrc.includes(s)));

  const timeouts = coreSrc.slice(coreSrc.indexOf('TOOL_TIMEOUT_OVERRIDES'));
  check('超时已登记（wait 60s / 其余 30s）',
    /team_wait: 60000/.test(timeouts) && /team_board: 30000/.test(timeouts)
    && /team_send_message: 30000/.test(timeouts) && /team_list_members: 30000/.test(timeouts));

  check('子进程通道白名单已登记',
    ['teamListMembers', 'teamSendMessage', 'teamBoard', 'teamWait'].every((c) => TOOL_CHANNELS.includes(c)));

  check('审批分级：写类 L2、只读类免审批',
    toolLevel('team_send_message') === 'L2' && toolLevel('team_wait') === 'L2'
    && READONLY_TOOLS.has('team_list_members') && READONLY_TOOLS.has('team_board'));
  check('可补偿性：send_message 不可逆、只读与等待可逆',
    reversibilityOf('team_send_message', 'L2').reversible === false
    && reversibilityOf('team_board', 'L1').reversible === true
    && reversibilityOf('team_wait', 'L2').reversible === true);
  check('三表互斥（tools 不同时出现在 TOOL_LEVEL 与 READONLY_TOOLS）',
    !['team_list_members', 'team_board'].some((n) => n in TOOL_LEVEL) && 'team_send_message' in REVERSIBILITY);

  check('模型可写消息类型 5 类且不含 system',
    MODEL_MESSAGE_KINDS.length === 5 && !MODEL_MESSAGE_KINDS.includes('system'));

  // ── D-810（第八轮 / 判据 6.2）：消息载荷类型化 —— 写入端 fail-closed ──
  // 缺陷背景：`kind` / `summary` / `toMemberId` 一直有校验（这部分是对的），但 `payload`
  // 与 `refs` 是**原样透传** —— 成员可以塞字符串、数组、深嵌套对象、数字 refs，全部落库。
  // 下游 normalizeTeamMessage 又会「尽力归一」，于是坏数据既不报错也不可用。
  // 这里锁的是**写入端拒绝**；读取端对历史脏数据的容忍由 team-stream 套件守护（不能混）。
  {
    const { h, calls } = build();
    const base = { summary: '结论一句话' };

    // 应当被拒的三类形状
    const rejects = [
      ['payload 为字符串（schema 声明是对象）', { ...base, payload: '本来是对象却传了字符串' }],
      ['payload 为数组', { ...base, payload: [1, 2, 3] }],
      ['payload 深嵌套超限', { ...base, payload: { a: { b: { c: { d: { e: 1 } } } } } }],
      ['refs 非数组', { ...base, refs: 'file://a' }],
      ['refs 混入非字符串', { ...base, refs: ['ok', 123] }],
      ['refs 单条超长', { ...base, refs: ['x'.repeat(513)] }],
      ['refs 条数超限', { ...base, refs: Array.from({ length: 21 }, (_, i) => `r${i}`) }],
    ];
    for (const [label, args] of rejects) {
      const r = h.teamSendMessage(args);
      check(`D-810 拒绝：${label}`, r.ok === false && typeof r.error === 'string' && r.error.length > 0,
        r && r.error);
    }
    check('D-810 被拒的调用不产生任何总线写入（拒绝发生在 postMessage 之前）',
      calls.postMessage.length === 0, `postMessage 调用 ${calls.postMessage.length} 次`);

    // 应当放行的形状（不能把「更严」做成「全拒」）
    const { h: h2, calls: calls2 } = build();
    const okCases = [
      ['payload 缺省', { summary: 's' }],
      ['payload 普通对象', { summary: 's', payload: { note: 'a', n: 1 } }],
      ['payload 四层内嵌套', { summary: 's', payload: { a: { b: { c: { d: 1 } } } } }],
      ['refs 正常字符串数组', { summary: 's', refs: ['file://a.tsx', 'task:1'] }],
    ];
    let allOk = true;
    let firstErr = '';
    for (const [label, args] of okCases) {
      const r = h2.teamSendMessage(args);
      if (!r.ok) { allOk = false; firstErr = `${label}: ${r.error}`; break; }
    }
    check('D-810 放行：合法载荷全部通过（更严不等于全拒）', allOk, firstErr);
    check('D-810 放行：合法调用确实写入总线', calls2.postMessage.length === okCases.length,
      `${calls2.postMessage.length}/${okCases.length}`);
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} team-tools：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);

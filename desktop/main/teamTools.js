// M5 / T5-8：军团协同工具（模型侧四个协作原语）。
//
// 工具集刻意**小于**设计稿 §8 原表的 8 个，只暴露 4 个协作层工具：
//   team_list_members（只读名册）、team_send_message（总线发言，受 G4 体积闸）、
//   team_board（只读看板投影）、team_wait（动态等待，复用 workerPool.waitTask 唯一入口）。
//
// 为什么控制层 4 个（create/update/remove_member、interrupt）**不接**：
//   ① 成员任务跑在无人值守通道（workerPool 的 runOpts.unattended=true）：那里没有审批通道，
//      任何需要用户批准的调用只能被立即拒绝——接进来就是「schema 可见、调用必失败」的死工具。
//   ② 编制变更属用户主权：设计稿 §9.1 规定 run 启动即打不可变编制快照，运行中改配置只影响
//      下一 run；让模型在 run 里改编制等于绕过快照制，也让审计无法复现。
//   ③ 看板写（认领/改状态）必须保持**调度器单写者**：worker 直接改状态会与 pump/claimNext
//      竞争，破坏 owner_member_id 与等待边的一致性。
// 控制层动作仍由用户经 teams:* IPC 完成，不经模型工具面。
//
// 安全边界（三条，全部在 handler 内闭环，模型参数不可伪造）：
//   · fromMemberId 一律取自 teamContext.memberId；
//   · runId 一律取自 teamContext.runId（模型即便传 runId 也被忽略）；
//   · toMemberId 必须属于同一团队；kind 拒绝 system（保留给宿主生命周期广播）。

// 模型可写入的消息类型：system 是宿主生命周期广播专用，模型不得伪造
//（否则「编制变更/组状态」这类系统事实会被模型消息冒充）。
const MODEL_MESSAGE_KINDS = ['assign', 'handoff', 'question', 'report', 'artifact_ref'];

// ── D-810（判据 6.2）：消息载荷类型化 ────────────────────────────────────
// 判据原文把「agent 间消息有类型化 schema 且两端校验」列为多智能体系统里**杠杆最高的
// 单一纪律**。此前的现实是：`kind` / `summary` / `toMemberId` 有校验（这部分是对的），
// 但 `payload` 是**原样透传**——spawn 出来的成员可以往里塞字符串、数组、深嵌套对象，
// 全部落库。下游 `normalizeTeamMessage` 又会尽力归一，于是坏数据「既不报错也不可用」。
//
// 分工必须写清楚（这是本改动唯一容易做错的地方）：
//   · **写入端（本文件）fail-closed**：形状不对直接拒，并给出可读原因 —— 模型据此改参数；
//   · **读取端（shared/teamStream.mjs 的 normalizeTeamMessage）保持容忍**：
//     历史数据里可能有非字符串 refs，读取端不能因为老数据脏就整条读不出来。
//   两端取舍不同不是不一致，而是「新数据不放过、老数据不丢」。
const { MESSAGE_REFS_MAX, MESSAGE_REF_MAX } = require('./teamStore');
// payload 深度上限：协作消息是「结论 + 引用」，4 层足够表达；
// 再深只可能是把整棵数据结构塞进总线（该走 refs + 落盘文件）。
const PAYLOAD_MAX_DEPTH = 4;

function isPlainObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function depthExceeds(v, limit, d = 0) {
  if (d > limit) return true;
  if (Array.isArray(v)) return v.some((x) => depthExceeds(x, limit, d + 1));
  if (v && typeof v === 'object') return Object.values(v).some((x) => depthExceeds(x, limit, d + 1));
  return false;
}

/** payload 校验：null/undefined 合法；否则必须是可序列化的普通对象且不超深度。 */
function validatePayload(payload) {
  if (payload == null) return { ok: true, value: null };
  if (Array.isArray(payload)) {
    return { ok: false, error: 'payload 必须是对象（数组请用 refs 传路径，不要塞进 payload）' };
  }
  if (!isPlainObject(payload)) {
    return { ok: false, error: `payload 必须是普通对象（当前 ${typeof payload}）——字符串/数字请放进 summary` };
  }
  if (depthExceeds(payload, PAYLOAD_MAX_DEPTH)) {
    return { ok: false, error: `payload 嵌套过深（上限 ${PAYLOAD_MAX_DEPTH} 层）：大对象请落盘后用 refs 传路径` };
  }
  try {
    JSON.stringify(payload);
  } catch {
    return { ok: false, error: 'payload 无法序列化（含循环引用或不可序列化值）' };
  }
  return { ok: true, value: payload };
}

/** refs 校验：必须是字符串数组，条数与单条长度都受既有上限约束。 */
function validateRefs(refs) {
  if (refs == null) return { ok: true, value: [] };
  if (!Array.isArray(refs)) return { ok: false, error: 'refs 必须是字符串数组' };
  if (refs.length > MESSAGE_REFS_MAX) {
    return { ok: false, error: `refs 条数超限（${refs.length} > ${MESSAGE_REFS_MAX}）：请合并或只传关键引用` };
  }
  for (const r of refs) {
    if (typeof r !== 'string') {
      return { ok: false, error: `refs 只能包含字符串（发现 ${r === null ? 'null' : typeof r}）` };
    }
    if (r.length > MESSAGE_REF_MAX) {
      return { ok: false, error: `refs 单条超长（${r.length} > ${MESSAGE_REF_MAX} 字符）：长内容请落盘后传路径` };
    }
  }
  return { ok: true, value: refs };
}

function trimStr(v, max = 0) {
  const s = String(v == null ? '' : v).trim();
  return max > 0 ? s.slice(0, max) : s;
}

/** 成员投影：只给协作必需字段，不下发 system_prompt（体量大且与协作无关） */
function projectMember(m, team) {
  return {
    memberId: m.id,
    name: m.name,
    roleKind: m.roleKind,
    isLead: m.id === team.leadMemberId,
    enabled: m.enabled !== false,
    toolNames: Array.isArray(m.toolNames) ? m.toolNames : [],
  };
}

/** 看板任务投影：**不含** prompt / result（可能很大），结论经 team_send_message 传递 */
function projectTask(t) {
  return {
    taskId: t.taskId,
    title: t.title,
    status: t.status,
    ownerMemberId: t.ownerMemberId || null,
    dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
    critical: !!t.critical,
  };
}

function err(error) {
  return { ok: false, error };
}

// 本地整数钳制（B-04）：只服务 team_read_messages 的 limit 参数。
// 不复用 teamStore 的 clampInt 是为了不把「库层内部工具」变成跨模块契约——
// 这里需要的是「非法输入回落默认」而库层需要的是「越界即钳到边界」，语义并不相同。
function clampIntLocal(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * @param {object} opts
 * @param {{teamId:string, runId:string, taskId:string, memberId:string}|null} opts.teamContext
 * @param {() => object|null} opts.getTeamStore
 * @param {() => object|null} opts.getTaskStore
 * @param {(input:object) => ({message:object, gated:boolean, reason:string|null}|null)} opts.postMessage
 * @param {(groupId:string, taskId:string, onTaskIds:string[], opts?:object) => object} opts.waitTask
 */
function createTeamToolHandlers({
  teamContext = null, getTeamStore, getTaskStore, postMessage, waitTask,
} = {}) {
  const ctx = teamContext || null;

  // 团队上下文自检：每个 handler 都先过这一关——宿主若误把工具注册到没有成员身份的运行上，
  // 这里返回结构化错误（而不是抛异常打断整轮），模型能据此改走别的路径。
  function requireContext() {
    if (!ctx || !ctx.teamId || !ctx.runId || !ctx.taskId) {
      return err('当前运行没有军团团队上下文（协同工具仅在成员任务内可用）');
    }
    return null;
  }

  function loadTeam() {
    const store = typeof getTeamStore === 'function' ? getTeamStore() : null;
    if (!store) return { error: err('团队子系统不可用') };
    let team = null;
    try { team = store.getTeam(ctx.teamId); } catch (e) { return { error: err(`读取团队失败：${e.message}`) }; }
    if (!team) return { error: err('团队不存在') };
    if (team.archivedAt) return { error: err('团队已归档：只读，不再接受协同操作') };
    return { team };
  }

  // ── team_list_members：只读名册（自动放行，不进审批面）──
  function teamListMembers() {
    const bad = requireContext();
    if (bad) return bad;
    const { team, error } = loadTeam();
    if (error) return error;
    return {
      ok: true,
      team: { teamId: team.id, name: team.name, description: team.description },
      me: ctx.memberId || null,
      leadMemberId: team.leadMemberId || null,
      members: team.members.map((m) => projectMember(m, team)),
    };
  }

  // ── team_send_message：写总线（自动，体积闸在 teamStore.appendMessage 内部）──
  function teamSendMessage(args = {}) {
    const bad = requireContext();
    if (bad) return bad;
    const summary = trimStr(args.summary);
    if (!summary) return err('summary 必填：请用一句话说明这条消息的结论/请求');
    const kind = trimStr(args.kind) || 'report';
    if (!MODEL_MESSAGE_KINDS.includes(kind)) {
      return err(`kind 非法：「${kind}」（可用：${MODEL_MESSAGE_KINDS.join(' / ')}）`);
    }
    const { team, error } = loadTeam();
    if (error) return error;
    // 空 toMemberId = 广播；非空必须命中本团队名册（跨团队投递一律拒绝）
    const toMemberId = trimStr(args.toMemberId);
    if (toMemberId && !team.members.some((m) => m.id === toMemberId)) {
      return err(`toMemberId 不在本团队名册内：${toMemberId}`);
    }
    if (typeof postMessage !== 'function') return err('消息总线不可用');
    // D-810：写入端 fail-closed —— 形状不对直接拒，不做「尽力解析」
    const payloadCheck = validatePayload(args.payload);
    if (!payloadCheck.ok) return err(payloadCheck.error);
    const refsCheck = validateRefs(args.refs);
    if (!refsCheck.ok) return err(refsCheck.error);
    let r = null;
    try {
      r = postMessage({
        teamId: ctx.teamId,
        runId: ctx.runId,
        // 发送者取自上下文：模型传入的 fromMemberId 一律忽略（不可伪造他人身份）
        fromMemberId: ctx.memberId || null,
        toMemberId: toMemberId || null,
        kind,
        summary,
        payload: payloadCheck.value,
        refs: refsCheck.value,
      });
    } catch (e) {
      return err(`写入消息总线失败：${e.message}`);
    }
    if (!r || !r.message) return err('消息总线不可用');
    return {
      ok: true,
      messageId: r.message.id,
      seq: r.message.seq,
      // G4 体积闸触发时如实告知：payload 已被丢弃、summary 已截断（模型别以为原文已送达）
      gated: !!r.gated,
      ...(r.gated ? { note: `消息体积超限，已回落为「摘要 + 引用」：${r.reason || ''}` } : {}),
    };
  }

  // ── team_board：只读看板投影（不含 prompt/result，避免把大结果塞回上下文）──
  function teamBoard() {
    const bad = requireContext();
    if (bad) return bad;
    const store = typeof getTaskStore === 'function' ? getTaskStore() : null;
    if (!store) return err('任务看板不可用');
    let tasks = [];
    try { tasks = store.listTasks(ctx.runId) || []; } catch (e) { return err(`读取看板失败：${e.message}`); }
    const counts = { total: tasks.length, queued: 0, running: 0, waiting: 0, done: 0, failed: 0, skipped: 0 };
    for (const t of tasks) if (counts[t.status] != null) counts[t.status] += 1;
    return { ok: true, runId: ctx.runId, tasks: tasks.map(projectTask), counts };
  }

  // ── team_wait：动态等待（登记成功后由 WorkerPool 中止本 run 释放槽位）──
  function teamWait(args = {}) {
    const bad = requireContext();
    if (bad) return bad;
    if (typeof waitTask !== 'function') return err('等待通道不可用');
    const raw = Array.isArray(args.taskIds) ? args.taskIds : (Array.isArray(args.task_ids) ? args.task_ids : []);
    const taskIds = raw.map((v) => trimStr(v)).filter(Boolean);
    if (!taskIds.length) return err('taskIds 必填：请给出要等待的子任务 id（可用 team_board 查询）');
    const timeoutMs = Number(args.timeoutMs || args.timeout_ms);
    let r = null;
    try {
      r = waitTask(ctx.runId, ctx.taskId, taskIds, Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {});
    } catch (e) {
      return err(`登记等待失败：${e.message}`);
    }
    if (!r || r.ok === false) return { ok: false, error: (r && r.error) || '登记等待失败', waitingOn: [], waiting: false };
    // waiting=true：本 run 会被立即中止以释放槽位，唤醒后由调度器重新排队
    //（这一句必须如实告诉模型，避免它以为还能继续调用工具）
    return {
      ok: true,
      waiting: !!r.waiting,
      waitingOn: r.waitingOn || [],
      deadlineAt: r.deadlineAt || null,
      ...(r.waiting
        ? { note: '已进入等待：本次执行将立即收尾并让出并发槽位，依赖就绪后你的任务会被重新排队继续。' }
        : { note: '依赖已全部完成，无需挂起，可以继续当前任务。' }),
    };
  }

  // ── team_read_messages：模型侧读消息（B-04，2026-10-21）──
  // 为什么必须有它：此前总线是「模型只写、UI 只读」的单向通道——成员发得出去、收不回来，
  // 于是 `kind=question` / `handoff` 全是死语义（问了没人答、交接了对方不知道）。
  // 读语义的三条边界（都在 handler 内闭环，模型参数不可伪造）：
  //   · 作用域恒为 **本团队的本次 run**（runId 取自 teamContext，模型传 runId 一律忽略）——
  //     跨 run / 跨团队读消息会让成员看到不属于它的上下文；
  //   · **归档团队允许读**（归档 = 只读，不是「不可访问」），故这里不走 loadTeam 的归档拒绝；
  //   · 默认返回**最近** limit 条（后加入的成员不该被最早的寒暄刷屏），给了 afterSeq 才按游标向后读。
  function teamReadMessages(args = {}) {
    const bad = requireContext();
    if (bad) return bad;
    const store = typeof getTeamStore === 'function' ? getTeamStore() : null;
    if (!store || typeof store.listMessages !== 'function') return err('消息总线不可用');
    const limit = clampIntLocal(args.limit, 1, 50, 20);
    const afterSeq = Number(args.afterSeq ?? args.after_seq);
    const kindFilter = trimStr(args.kind);
    if (kindFilter && !MODEL_MESSAGE_KINDS.includes(kindFilter) && kindFilter !== 'system') {
      return err(`kind 过滤值非法：「${kindFilter}」（可用：${MODEL_MESSAGE_KINDS.join(' / ')} / system）`);
    }
    let rows = [];
    try {
      // 先按上限取一段（团队单 run 的消息量级很小；200 是 teamStore 的既有上限口径），
      // 未给游标时取尾部 limit 条，给了游标则从游标之后顺序读——两种语义都返回 seq 升序。
      const hasCursor = Number.isFinite(afterSeq);
      rows = store.listMessages({
        teamId: ctx.teamId,
        runId: ctx.runId,
        ...(hasCursor ? { afterSeq: Math.trunc(afterSeq) } : {}),
        limit: hasCursor ? limit : 200,
      }) || [];
      if (!hasCursor && rows.length > limit) rows = rows.slice(-limit);
    } catch (e) {
      return err(`读取消息失败：${e.message}`);
    }
    const messages = rows
      .filter((m) => !kindFilter || m.kind === kindFilter)
      .map((m) => ({
        seq: m.seq,
        id: m.id,
        from: m.fromMemberId || null,
        to: m.toMemberId || null,
        kind: m.kind,
        summary: m.summary,
        refs: Array.isArray(m.refs) ? m.refs : [],
        // payload 只给「有没有 + 有哪些键」：正文体积不可控，取值该走 refs 指向的文件
        hasPayload: m.payload != null,
        payloadKeys: (m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload)) ? Object.keys(m.payload) : [],
        createdAt: m.createdAt || null,
      }));
    const cursor = messages.length ? messages[messages.length - 1].seq : (Number.isFinite(afterSeq) ? Math.trunc(afterSeq) : null);
    return {
      ok: true,
      runId: ctx.runId,
      me: ctx.memberId || null,
      count: messages.length,
      cursor,
      messages,
      ...(messages.length === 0 ? { note: '游标之后没有新消息' } : {}),
    };
  }

  return { teamListMembers, teamSendMessage, teamBoard, teamWait, teamReadMessages };
}

module.exports = { createTeamToolHandlers, MODEL_MESSAGE_KINDS };

// M5 / T5-6：对话内团队协同事件流的**纯投影层**（设计稿 v1.5 §13.5）。
//
// 为什么单独一个纯函数模块：
//   · 主进程只负责「把事实捞出来」（哪些 run / 哪些消息 / 哪些任务），不做 UI 口径；
//   · 渲染层只负责「把投影画出来」，不重复判断排序、去重、成员名解析；
//   · 投影是确定性的（输入同 → 输出同），因此可以在 Node 里直接单测，不需要起 React/DOM。
//
// 三条硬语义（与存储层一致，别处不得另写）：
//   ① 顺序 = `seq` 升序（team_messages 的 seq 是团队内单调的唯一顺序事实源）；
//   ② 卡片顺序 = 建组时间升序（与对话从上到下一致）；
//   ③ 未知 kind 一律回落 `system`（fail-closed：界面永不渲染裸 kind 字符串）。
//
// 本模块零依赖、零 React、零 i18n：只产出「结构 + 计数」，文案由渲染层 t() 决定。

export const TEAM_MESSAGE_KINDS = ['assign', 'handoff', 'question', 'report', 'artifact_ref', 'system'];

// T6-4（§5.1）：quota_suspend 必须进入进度口径——否则暂停期间卡片计数里「少了这批任务」，
// 用户看到 total 与实际任务数不符。它是非终态，但也不是 running/queued，需要独立分组。
const TASK_PROGRESS_KEYS = ['done', 'failed', 'running', 'waiting', 'queued', 'pending', 'skipped', 'quota_suspend'];

function asString(v) {
  return String(v == null ? '' : v).trim();
}

/**
 * 摘要归一为可读文本（2026-10-22 真机反馈：对话卡出现 `[object Object],...`）。
 *
 * 为什么需要：`aggregator/merge.js` 的 `merged.summary` 是**结构化对象数组**
 * `[{taskId,title,text}]`（供程序消费），组终态直接原样落到 `task_groups.result_json`。
 * 渲染层此前 `String(array)` 得到 `[object Object]`，用户看到的就是一串乱码。
 * 归一放在投影层（唯一渲染口径）：存储保持结构化不变，历史 run 重放也能正确显示。
 *
 * 兼容三种历史形态：字符串 / 对象数组 / 纯字符串数组；无法识别的对象回落 `text|summary`。
 * @param {unknown} raw
 * @returns {string}
 */
export function summaryTextOf(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((it) => {
        if (it == null) return '';
        if (typeof it === 'string') return it;
        if (typeof it !== 'object') return String(it);
        const text = String(it.text == null ? '' : it.text).trim();
        if (!text) return '';
        const title = asString(it.title);
        return title ? `${title}：${text}` : text;
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof raw === 'object') return String(raw.text == null ? (raw.summary == null ? '' : raw.summary) : raw.text);
  return String(raw);
}

/**
 * 派活计划的可观测部分（第八轮 B-05）：`dag.runMeta.dispatch` → 卡片字段。
 *
 * 为什么读 `dag.runMeta` 而不是读派活消息的 payload：
 *   payload 是「当时说了什么」，runMeta 是「当时计划了什么」，而卡片要解释的是后者；
 *   且 runMeta 随 dag_json 一次落库，历史 run 重放得到同一结果（消息可能被截断/裁剪）。
 * 缺键 → 全 0 / 空数组（旧 run、普通编排组都是这个形态），不造字段、不抛错。
 * @param {any} full taskStore.getGroup 的返回值
 * @returns {{mode:string, active:number, deferred:number, deferredReasons:string[]}}
 */
function dispatchInfoOf(full) {
  const d = full && full.dag && full.dag.runMeta && full.dag.runMeta.dispatch;
  if (!d || typeof d !== 'object') return { mode: '', active: 0, deferred: 0, deferredReasons: [] };
  const deferred = Array.isArray(d.deferredMembers) ? d.deferredMembers : [];
  const reasons = [...new Set(deferred.map((x) => asString(x && x.reason)).filter(Boolean))];
  return {
    mode: asString(d.mode),
    active: Array.isArray(d.activeMemberIds) ? d.activeMemberIds.length : 0,
    deferred: deferred.length,
    deferredReasons: reasons,
  };
}

/**
 * 组预算视图（2026-10-21 用户需求：预算可视化）。
 *
 * 数据源有两条，各管一段，不互相替代：
 *   · `dag.runMeta.budget` —— 计划口径（上限），随 dag_json 落库，历史 run 可复现；
 *   · `task.result.tokensUsed` —— 已结算的实际用量（任务结束才有值）；
 *   · `live` —— 主进程内存账本 `groupBudget.snapshotOf`（含在途结算值），仅当次进程有效。
 *     历史卡没有 live 也能显示（用量来自任务结果），因此 live 是**增强**不是必需。
 *
 * 四条边界：无预算 → 返回 null（普通编排组不该显示 0/0 的假预算条）；
 * 上限非数字 → 0；用量取「已结算」与「内存账本」的较大值，避免两账不同步时显示回退；
 * 百分比夹在 0~100（软上限下实际用量可能超额，界面不画超 100% 的条）。
 * @param {any} full taskStore.getGroup 的返回值
 * @param {{tokens?:number, elapsedMs?:number}|null} live groupBudget.snapshotOf 的产物
 * @returns {{maxTokens:number, maxRounds:number, maxWallMs:number, usedTokens:number,
 *   remainingTokens:number, percent:number, elapsedMs:number, byTask:Record<string,number>}|null}
 */
export function budgetInfoOf(full, live) {
  const b = full && full.dag && full.dag.runMeta && full.dag.runMeta.budget;
  if (!b || typeof b !== 'object') return null;
  const maxTokens = Math.max(0, Number(b.max_tokens) || 0);
  const maxRounds = Math.max(0, Number(b.max_rounds) || 0);
  const maxWallMs = Math.max(0, Number(b.max_wall_ms) || 0);
  const byTask = {};
  let persisted = 0;
  for (const t of (Array.isArray(full.tasks) ? full.tasks : [])) {
    const id = asString(t && t.taskId);
    const n = Math.max(0, Number(t && t.result && t.result.tokensUsed) || 0);
    if (id) byTask[id] = n;
    persisted += n;
  }
  const usedTokens = Math.max(persisted, Math.max(0, Number(live && live.tokens) || 0));
  return {
    maxTokens,
    maxRounds,
    maxWallMs,
    usedTokens,
    remainingTokens: Math.max(0, maxTokens - usedTokens),
    percent: maxTokens > 0 ? Math.min(100, Math.round((usedTokens / maxTokens) * 100)) : 0,
    elapsedMs: Math.max(0, Number(live && live.elapsedMs) || 0),
    byTask,
  };
}

/** 渲染层投影用的预算归一（缺键返回 null；字段一律数字，避免界面出现 NaN）。 */
function normalizeBudgetView(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    maxTokens: Math.max(0, Number(raw.maxTokens) || 0),
    maxRounds: Math.max(0, Number(raw.maxRounds) || 0),
    maxWallMs: Math.max(0, Number(raw.maxWallMs) || 0),
    usedTokens: Math.max(0, Number(raw.usedTokens) || 0),
    remainingTokens: Math.max(0, Number(raw.remainingTokens) || 0),
    percent: Math.max(0, Math.min(100, Number(raw.percent) || 0)),
    elapsedMs: Math.max(0, Number(raw.elapsedMs) || 0),
    byTask: raw.byTask && typeof raw.byTask === 'object' ? { ...raw.byTask } : {},
  };
}

/**
 * 任务活动轨迹归一（M5 / T5-6，2026-10-21）：来自 `task_events` 表 / 运行期事件。
 * 只保留渲染需要的字段；payload 原样透传（写入侧已做长度裁剪）。
 */
export function normalizeTaskEvent(raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  return {
    id: Number(e.id) || 0,
    groupId: asString(e.groupId) || null,
    taskId: asString(e.taskId) || null,
    type: asString(e.type) || 'activity',
    payload: e.payload && typeof e.payload === 'object' ? e.payload : null,
    createdAt: Number(e.createdAt) || 0,
  };
}

function oneOfKind(kind) {
  const k = asString(kind);
  return TEAM_MESSAGE_KINDS.includes(k) ? k : 'system';
}

/** 消息归一：只保留投影需要的字段，未知 kind 回落 system，seq 强制为数字。 */
export function normalizeTeamMessage(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const seq = Number(m.seq);
  return {
    id: asString(m.id),
    seq: Number.isFinite(seq) ? seq : 0,
    kind: oneOfKind(m.kind),
    summary: String(m.summary == null ? '' : m.summary),
    fromMemberId: asString(m.fromMemberId) || null,
    toMemberId: asString(m.toMemberId) || null,
    refs: Array.isArray(m.refs) ? m.refs.map((r) => asString(r)).filter(Boolean) : [],
    payload: m.payload && typeof m.payload === 'object' ? m.payload : null,
    createdAt: Number.isFinite(Number(m.createdAt)) ? Number(m.createdAt) : 0,
  };
}

/** 进度统计：以看板任务状态为权威事实（skipped 计入 total，但不计入 done/failed）。 */
export function taskProgress(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const out = { total: list.length };
  for (const key of TASK_PROGRESS_KEYS) out[key] = 0;
  for (const t of list) {
    const s = asString(t && t.status);
    if (Object.prototype.hasOwnProperty.call(out, s)) out[s] += 1;
  }
  return out;
}

/**
 * 投影：主进程返回的 run 列表 → 对话内卡片模型。
 *
 * 输入 run 形状（ipc/teams.js `teams:listThreadRuns`）：
 *   { runId, teamId, teamName, status, goal, summary, error, waves, createdAt,
 *     dispatch:{mode,active,deferred,deferredReasons},
 *     members:[{id,name,roleKind,avatar,enabled}], tasks:[{taskId,title,status,ownerMemberId,resultSummary,error}],
 *     messages:[...] }
 * 输出卡片额外带：
 *   · messages 已按 seq 升序去重；
 *   · tasks 已补 ownerName（成员名解析只在这一次，组件不再拼）；
 *   · progress / counts（折叠态直接显示，不必展开算）。
 */
export function projectTeamRuns(runs) {
  const list = Array.isArray(runs) ? runs : [];
  const cards = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const runId = asString(raw.runId);
    if (!runId) continue;
    const members = (Array.isArray(raw.members) ? raw.members : [])
      .filter((m) => m && asString(m.id))
      .map((m) => ({
        id: asString(m.id),
        name: asString(m.name) || asString(m.id),
        roleKind: asString(m.roleKind) === 'lead' ? 'lead' : 'member',
        avatar: asString(m.avatar) || null,
        enabled: m.enabled !== false,
      }));
    const nameById = new Map(members.map((m) => [m.id, m.name]));

    // 消息：去重（同一 id 只留一条）→ 按 seq 升序。事件增量与历史快照重叠时不会重复渲染。
    const seen = new Set();
    const messages = (Array.isArray(raw.messages) ? raw.messages : [])
      .map(normalizeTeamMessage)
      .filter((m) => {
        if (!m.id) return false;
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      })
      .sort((a, b) => a.seq - b.seq);

    const tasks = (Array.isArray(raw.tasks) ? raw.tasks : [])
      .filter((t) => t && asString(t.taskId))
      .map((t) => ({
        taskId: asString(t.taskId),
        title: String(t.title == null ? '' : t.title),
        status: asString(t.status),
        ownerMemberId: asString(t.ownerMemberId) || null,
        ownerName: nameById.get(asString(t.ownerMemberId)) || '',
        resultSummary: summaryTextOf(t.resultSummary),
        // 产物路径（任务 result.artifacts）：对话卡/看板可点击打开（T5-6 遗留项）
        artifacts: Array.isArray(t.artifacts) ? t.artifacts.map(asString).filter(Boolean) : [],
        error: String(t.error == null ? '' : t.error),
        // 看板字段（依赖 / 关键路径 / 运行期等待边）原样透传，投影层不做语义改写
        dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(asString).filter(Boolean) : [],
        critical: t.critical === true,
        waitingOn: Array.isArray(t.waitingOn) ? t.waitingOn.map(asString).filter(Boolean) : [],
        // 处理流程（T5-6，2026-10-21）：该任务的工具调用/撤员/改派/等待轨迹
        events: (Array.isArray(t.events) ? t.events : []).map(normalizeTaskEvent),
        // 预算可视化：该任务实际消耗（任务结束才有值，运行中为 0）
        tokensUsed: Math.max(0, Number(t.tokensUsed) || 0),
      }));

    const counts = { total: messages.length, byKind: {} };
    for (const m of messages) counts.byKind[m.kind] = (counts.byKind[m.kind] || 0) + 1;

    const lastMessageAt = messages.length ? messages[messages.length - 1].createdAt : 0;
    cards.push({
      runId,
      // kind：team=军团派活（有团队归属），orchestration=普通任务编排（统一显示，2026-10-21）
      kind: asString(raw.kind) === 'orchestration' ? 'orchestration' : 'team',
      teamId: asString(raw.teamId),
      // 普通编排没有团队名：留空由渲染层按 i18n 显示「项目编排」，不在数据层造中文。
      teamName: asString(raw.teamName) || asString(raw.teamId),
      status: asString(raw.status) || 'ready',
      goal: String(raw.goal == null ? '' : raw.goal),
      summary: summaryTextOf(raw.summary),
      error: String(raw.error == null ? '' : raw.error),
      waves: Number.isFinite(Number(raw.waves)) ? Number(raw.waves) : 0,
      // 第八轮 B-05：派活计划口径（谁被闸门挡下、为什么）。缺键给零值，渲染层按 0 不展示。
      dispatch: (raw.dispatch && typeof raw.dispatch === 'object')
        ? {
          mode: asString(raw.dispatch.mode),
          active: Number(raw.dispatch.active) || 0,
          deferred: Number(raw.dispatch.deferred) || 0,
          deferredReasons: Array.isArray(raw.dispatch.deferredReasons)
            ? raw.dispatch.deferredReasons.map(asString).filter(Boolean) : [],
        }
        : { mode: '', active: 0, deferred: 0, deferredReasons: [] },
      // 预算可视化（2026-10-21）：无预算的组（普通编排 / 旧 run）为 null，界面不画预算条。
      budget: normalizeBudgetView(raw.budget),
      createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : 0,
      updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0,
      lastActivityAt: Math.max(Number(raw.updatedAt) || 0, lastMessageAt),
      members,
      messages,
      tasks,
      progress: taskProgress(tasks),
      counts,
    });
  }
  // 卡片按建组时间升序：对话从上到下 = 从旧到新；同一毫秒用 runId 兜底保证确定性。
  cards.sort((a, b) => (a.createdAt - b.createdAt) || a.runId.localeCompare(b.runId));
  return cards;
}

/** 成员名解析（组件里展示「谁 → 谁」时用；找不到回落 id，避免空白气泡）。 */
export function memberLabel(card, memberId) {
  const id = asString(memberId);
  if (!id) return '';
  const hit = (card && Array.isArray(card.members) ? card.members : []).find((m) => m.id === id);
  return hit ? hit.name : id;
}

/**
 * M5 / T5-6：把「会话任务组 + 总线消息 + 活动轨迹」装配成 run 摘要（主进程 `teams:listThreadRuns` 的纯内核）。
 *
 * 2026-10-21 用户口径变更（统一显示）：普通任务编排（autoOrchestrate / orchestrate_task）与
 * 军团派活**共用同一套对话内卡片**——两者都是「一个目标被拆成多个子任务并分派」，用户不需要
 * 记两套界面。因此本函数不再只认「有 team_messages 的组」：
 *   · 有 team_messages 且团队存在 ⇒ kind='team'（带团队名与成员快照）；
 *   · 没有任何团队消息的组        ⇒ kind='orchestration'（团队名为空，渲染层显示「项目编排」）；
 *   · 有消息但团队已删除          ⇒ 仍保留为 orchestration（历史可追溯，不出现点开即空的孤儿卡）。
 *
 * 为什么要注入 getGroup/getTeam 而不是直接查库：
 *   装配是纯数据变换（可单测），查库是宿主职责；注入后单测可用假数据覆盖各分支，不必起 SQLite。
 *
 * 输出按建组时间倒序（最新在前），渲染层投影时再统一转成对话顺序（旧 → 新）。
 */
export function assembleThreadRuns({ groups, messages, events, getGroup, getTeam, getBudgetLive }) {
  const groupList = (Array.isArray(groups) ? groups : []).filter((g) => asString(g && g.group_id));
  const msgList = Array.isArray(messages) ? messages : [];
  const eventList = (Array.isArray(events) ? events : []).map(normalizeTaskEvent);
  const eventsByRun = new Map();
  for (const e of eventList) {
    const rid = asString(e.groupId);
    if (!rid) continue;
    if (!eventsByRun.has(rid)) eventsByRun.set(rid, []);
    eventsByRun.get(rid).push(e);
  }
  const runs = [];
  for (const g of groupList) {
    const runId = asString(g.group_id);
    const runMessages = msgList.filter((m) => asString(m && m.runId) === runId);
    const teamId = runMessages.length ? asString(runMessages[0].teamId) : '';
    const team = teamId && typeof getTeam === 'function' ? getTeam(teamId) : null;
    const full = typeof getGroup === 'function' ? getGroup(runId) : null;
    if (!full) continue; // 组已物理删除 ⇒ 不展示空壳卡
    const tasks = (Array.isArray(full.tasks) ? full.tasks : []).map((t) => ({
      taskId: asString(t.taskId),
      title: String(t.title == null ? '' : t.title),
      status: asString(t.status),
      ownerMemberId: asString(t.ownerMemberId) || null,
      resultSummary: summaryTextOf(t.result && t.result.summary),
      // 产物路径：对话卡/看板「引用」可点击打开（T5-6 遗留项）
      artifacts: Array.isArray(t.result && t.result.artifacts) ? t.result.artifacts.map(asString).filter(Boolean) : [],
      error: t.error || '',
      // 看板：依赖与关键路径是「任务为什么还没开始」的唯一可见解释，
      // 只读投影（不含 prompt），供看板列显示依赖指向。
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(asString).filter(Boolean) : [],
      critical: t.critical === true,
      waitingOn: Array.isArray(t.waitingOn) ? t.waitingOn.map(asString).filter(Boolean) : [],
      // 该任务的处理轨迹（工具调用/撤员/改派/等待），按发生顺序
      events: (eventsByRun.get(runId) || []).filter((e) => e.taskId === asString(t.taskId)),
      // 预算可视化：任务已结算的实际消耗（未结束为 0）
      tokensUsed: Math.max(0, Number(t && t.result && t.result.tokensUsed) || 0),
    }));
    runs.push({
      runId,
      kind: team ? 'team' : 'orchestration',
      teamId: team ? asString(team.id) || teamId : '',
      teamName: team ? (asString(team.name) || asString(team.id) || teamId) : '',
      status: asString(full.status) || 'ready',
      goal: String(full.goal == null ? '' : full.goal),
      createdAt: Number(full.created_at) || 0,
      updatedAt: Number(full.updated_at) || 0,
      summary: summaryTextOf(full.result && full.result.summary),
      error: full.error || '',
      waves: full.dag && Array.isArray(full.dag.waves) ? full.dag.waves.length : 0,
      // 第八轮 B-05：类型闸/人数闸挡下的成员数（用户在派活卡上要能看见「派了 10 人、3 人没上」
      // 以及原因）。数据源是 dag.runMeta.dispatch（随计划一起落库，run 级快照，可复现）；
      // 读不到就是 0（旧 run / 普通编排组没有这个键），不抛错、不造字段。
      dispatch: dispatchInfoOf(full),
      // 预算可视化：上限来自计划快照，实时用量由宿主注入（groupBudget.snapshotOf）。
      // 注入缺失（历史 run / 普通编排）时仅按已结算任务用量计算，界面仍可读。
      budget: budgetInfoOf(full, typeof getBudgetLive === 'function' ? getBudgetLive(runId) : null),
      // M5 / T5-9：成员列表与运行期同口径——run 快照优先，缺失才回落实时名册。
      // 若这里读实时名册，中途被下架的成员会在历史卡上「消失」，而任务 owner 仍指向他，
      // 表现为「未认领的任务却有产出」；快照优先保证历史 run 可复现、可审计。
      members: (Array.isArray(full?.dag?.roster) && full.dag.roster.length
        ? full.dag.roster
        : (Array.isArray(team?.members) ? team.members : [])).map((m) => ({
        id: asString(m.id),
        name: asString(m.name) || asString(m.id),
        roleKind: asString(m.roleKind) === 'lead' ? 'lead' : 'member',
        avatar: asString(m.avatar) || null,
        enabled: m.enabled !== false,
      })),
      tasks,
      // 组级轨迹（无任务归属的事件，如批次/派活级活动）
      events: (eventsByRun.get(runId) || []).filter((e) => !e.taskId),
      messages: runMessages.map((m) => ({
        id: m.id,
        seq: m.seq,
        kind: m.kind,
        summary: m.summary,
        fromMemberId: m.fromMemberId,
        toMemberId: m.toMemberId,
        refs: m.refs,
        payload: m.payload,
        createdAt: m.createdAt,
      })),
    });
  }
  runs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return runs;
}

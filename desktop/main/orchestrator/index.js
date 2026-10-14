// P1-4：Orchestrator 最小版——用户目标 → LLM 拆解 → DAG 校验 → 持久化任务组
// 职责边界：只做「拆解与建组」；执行交给 WorkerPool；聚合交给 Aggregator。
// LLM 调用复用定时任务通道的非流式 chatOnce（凭证解析同源，无流式需求）。
const crypto = require('crypto');
// P1-4：同时引入规模常量，让拆解提示与 DAG 校验共用同一口径（消除「提示说2~6、校验允8」的漂移）
const { validateDag, topoLevels, MAX_TASKS, MIN_TASKS } = require('./dag');

const ORCHESTRATOR_SYSTEM = [
  '你是 MJ Coder 的任务编排器。把用户目标拆解为可独立执行的子任务 DAG，输出严格 JSON（不要输出任何其他文本）：',
  '{"tasks":[{"id":"t1","title":"简短标题","prompt":"给 Worker 的完整执行指令（含验收标准）","dependsOn":["前置任务id"],"critical":false,"maxRetry":1}]}',
  '规则：',
  // P1-4：规模约束与 dag.js 的 validateDag 保持严格一致（MAX_TASKS=8）。
  // 事故背景：此处原写「2~6 个」而 dag.js 允许至多 8 个，LLM 产出 7-8 个任务时
  // 会被提示与校验「双重口径」夹住——模型可能自我矛盾，或反复重试浪费轮次。
  // 现在两处同源引用 dag.js 的常量，从结构上消除不一致。
  `1. 任务数 ${MIN_TASKS}~${MAX_TASKS} 个；每个任务应可由一个独立 Agent 用工具（读文件/写文件/执行命令）完成；`,
  '2. 没有数据/产物依赖的任务必须写 dependsOn:[] 并放进同一批次并行执行——仅在真正需要前置任务产出时才声明依赖；禁止把可并行的任务串成链；',
  '3. critical:true 仅用于「失败后后续任务都无意义」的核心步骤（如初始化、编译基线），其余一律 false；',
  '4. prompt 必须自包含：写清楚目标、涉及路径、验收方式；禁止引用对话上下文；',
  '5. 输出只能是 JSON，以 { 开头以 } 结尾。',
].join('\n');

let deps = null;

function initOrchestrator(d) {
  deps = d; // { loadAgentCore, store, chatOnce, resolveModel, emit, runGroup? }
}

// 组装拆解请求的用户消息：目标 + 项目目录 + 上下文块（修复提示 / 重规划上下文）
function buildUserMessage(goal, cwd, extra) {
  const lines = [`【用户目标】\n${goal}`, `【项目目录】\n${cwd || '（未指定）'}`];
  if (extra) lines.push(extra);
  return lines.join('\n\n');
}

async function askDag(userMessage) {
  const model = deps.resolveModel(); // 未选模型时抛出明确错误
  const res = await deps.chatOnce({
    providerId: model.providerId,
    isGlobal: !!model.isGlobal,
    baseUrl: model.baseUrl || '',
    model: model.model,
    messages: [
      { role: 'system', content: ORCHESTRATOR_SYSTEM },
      { role: 'user', content: userMessage },
    ],
  });
  return { content: res?.content || '' };
}

// 拆解并建组。返回 { ok, groupId?, tasks?, levels?, error? }
// opts：{ auto, replanDepth, replanOf, repairHint, contextBlock }
//   · repairHint：上一次输出非法 JSON 时回喂的错误（自动修复重试路径）
//   · contextBlock：重规划时注入的「上次执行情况」（已完成结论 / 失败原因）
async function planGoal({ goal, cwd, auto, replanDepth, replanOf, repairHint, contextBlock } = {}) {
  const g = String(goal || '').trim();
  if (!g) return { ok: false, error: '目标为空' };
  if (!deps) return { ok: false, error: 'Orchestrator 未初始化' };

  const extra = repairHint
    ? `【修复要求】上一次输出未通过校验，原因：${repairHint}\n请重新输出严格 JSON，以 { 开头以 } 结束。`
    : contextBlock || '';

  let content = '';
  try {
    ({ content } = await askDag(buildUserMessage(g, cwd, extra)));
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }

  const dag = validateDag(content);
  if (!dag.ok) return { ok: false, error: dag.error, raw: content.slice(0, 2000) };

  const levels = topoLevels(dag.tasks);
  const groupId = `tg-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  deps.store.createGroup({
    groupId, goal: g, cwd, dag: { levels }, tasks: dag.tasks,
    auto, replanDepth, replanOf,
  });
  deps.emit?.({ type: 'group_created', groupId, goal: g, tasks: dag.tasks, levels, replanOf: replanOf || null });
  return { ok: true, groupId, tasks: dag.tasks, levels };
}

// ── 自动编排（WorkBuddy 式主理人模式）──
// 一键流：目标 → 自动拆解（JSON 校验失败自动回喂修复，最多重试 1 次）→ 自动执行。
async function autoOrchestrate({ goal, cwd } = {}) {
  if (!deps?.runGroup) return { ok: false, error: '自动编排依赖未就绪' };
  let r = await planGoal({ goal, cwd, auto: true, replanDepth: 0 });
  if (!r.ok && r.raw) {
    // 拆解输出非法 → 带原始错误自动修复重试一次
    r = await planGoal({ goal, cwd, auto: true, replanDepth: 0, repairHint: r.error });
  }
  if (!r.ok) return r;
  deps.emit?.({ type: 'auto_run', groupId: r.groupId, tasks: r.tasks.length });
  deps.runGroup(r.groupId).catch((e) => deps.emit?.({ type: 'group_update', groupId: r.groupId, status: 'failed', error: e.message }));
  return r;
}

// 重规划上下文：把上次执行结果（已完成结论摘要 / 失败原因 / 跳过）压缩为 LLM 可用的块
function buildReplanContext(srcGroup) {
  const done = (srcGroup.tasks || []).filter((t) => t.status === 'done')
    .map((t) => `- 已完成「${t.title}」：${String(t.result?.summary || '').slice(0, 200)}`);
  const failed = (srcGroup.tasks || []).filter((t) => t.status === 'failed')
    .map((t) => `- 失败「${t.title}」：${String(t.error || '原因未知').slice(0, 200)}`);
  const skipped = (srcGroup.tasks || []).filter((t) => t.status === 'skipped')
    .map((t) => `- 跳过「${t.title}」`);
  return [
    '【上次自动编排执行情况（重新拆解时的依据）】',
    '已完成任务的结论可直接作为输入引用，不要安排重复执行；',
    '失败任务需调整拆解方式或拆出更小的步骤以绕过失败原因：',
    ...done, ...failed, ...skipped,
    `【失败总结】${String(srcGroup.error || '关键任务失败').slice(0, 200)}`,
  ].join('\n');
}

// 自动重规划：auto 组终态失败/暂停 → 以失败上下文重新拆解为新组并续跑。
// 防失控：每条 replan 链最多自动重规划 1 次（depth≥1 不再重规划，交人工处置）。
const replanning = new Set(); // 并发去重（同一组只触发一次）

async function maybeAutoReplan(groupId) {
  if (!deps?.runGroup) return null;
  const src = deps.store.getGroup(groupId);
  if (!src || !src.auto || (src.replan_depth || 0) >= 1) return null;
  if (src.status !== 'failed' && src.status !== 'paused') return null;
  if (replanning.has(groupId)) return null;
  replanning.add(groupId);

  try {
    const r = await planGoal({
      goal: src.goal, cwd: src.cwd,
      auto: true, replanDepth: (src.replan_depth || 0) + 1, replanOf: groupId,
      contextBlock: buildReplanContext(src),
    });
    if (!r.ok) {
      deps.emit?.({ type: 'replan_failed', groupId, error: r.error });
      console.error(`[orchestrator] 组 ${groupId} 自动重规划失败:`, r.error);
      return null;
    }
    console.log(`[orchestrator] 组 ${groupId} 失败，已自动重规划为新组 ${r.groupId}（${r.tasks.length} 个子任务）`);
    deps.runGroup(r.groupId).catch((e) => console.error(`[orchestrator] 重规划组 ${r.groupId} 启动失败:`, e.message));
    return r;
  } catch (e) {
    console.error('[orchestrator] 自动重规划异常:', e.message);
    return null;
  } finally {
    replanning.delete(groupId);
  }
}

// 事件入口：main 层把任务事件同步喂给编排器（触发自动重规划）
function onTaskEvent(evt) {
  if (!evt) return;
  if (evt.type === 'group_finalized' && (evt.status === 'failed' || evt.status === 'paused')) {
    maybeAutoReplan(evt.groupId);
  } else if (evt.type === 'group_update' && evt.status === 'paused') {
    maybeAutoReplan(evt.groupId);
  }
}

module.exports = { initOrchestrator, planGoal, autoOrchestrate, maybeAutoReplan, onTaskEvent, buildReplanContext, ORCHESTRATOR_SYSTEM };

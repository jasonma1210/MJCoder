// 组级三键预算闸 —— G2 预算从「提示词文案」变成「运行期强制点」
//
// 背景（第八轮审查 B-02 / 决策 D-809）：
//   `BUDGET_DEFAULTS`（max_rounds / max_tokens / max_wall_ms）此前只出现在三个地方：
//   ① 拼进 `buildTeamContext` 的提示词文案；② 派活消息 `payload.budget`；③ 审计串。
//   运行期**零强制点** —— 实际只有 per-task `timeoutMs` 一闸，组级墙钟根本不存在。
//   后果是「有预算声明、没有预算执行」：模型被告知有上限，但没有任何代码在越界时叫停。
//
//   本模块是该策略的**唯一落点**。workerPool 只保留调用点（三行），不承载任何判定逻辑 ——
//   这不是为拆文件而拆文件：workerPool 已逼近 800 行软档，预算策略本属「组级调度策略」，
//   与「怎么跑一个任务」是两件不同的事。
//
// 三键的确定性语义（判据 6.3：触达时必须是**确定性终止**，不能交给模型判断）：
//   · max_wall_ms —— 组起跑即计时；每个在途任务的超时被**夹到剩余额度**，
//                    因此整组墙钟不会超过 max_wall_ms 加一次任务启动开销。
//   · max_tokens  —— 每任务结束后累加实际用量；起新任务前判定，越界即停止派生新工作。
//   · max_rounds  —— 直接作为每个任务引擎侧的 `maxRounds`（替换原先硬编码的 20）。
//
// 设计取舍（写清楚，避免被读成缺陷）：
//   · **不 abort 在途任务**。越界时停止派生 + 夹紧剩余超时，让在途任务自然收尾，
//     比强行 kill 更安全（kill 会丢部分产出，而部分产出对本项目是有价值的验收材料）。
//   · **令牌账在任务结束后结算**，不与引擎内部逐轮统计对齐 —— 引擎侧的 `tokenBudget`
//     管的是单任务生成侧，本模块管的是组级累计，两者口径不同、互不替代。
//     「在途任务用量未入账」是有意的保守近似：宁可多放一个任务，不误杀进行中的工作。
//   · **不发明第二种组状态语义**。越界只把未开始任务置 skipped，组状态仍交给既有的
//     `isGroupSettled → finalizeGroup` 判定（关键任务失败自然成 failed）。
//   · 无预算的组（普通编排组 `dag.runMeta` 缺失）→ 全部判定为「不设限」，零回归。

'use strict';

const { normalizeBudget } = require('./teamStore');

// groupId → { startedAt, tokens }
const state = new Map();

/** 从组对象读出预算（唯一来源：`dag.runMeta.budget`，由派活层随 dag_json 落库）。 */
function readBudget(group) {
  const raw = group && group.dag && group.dag.runMeta && group.dag.runMeta.budget;
  return normalizeBudget(raw);
}

/** 组起跑登记（幂等：重复调用不重置计时，防止重入把墙钟清零）。 */
function begin(groupId) {
  if (!groupId) return null;
  if (!state.has(groupId)) state.set(groupId, { startedAt: Date.now(), tokens: 0 });
  return state.get(groupId);
}

/** 有预算才登记（workerPool 的 runGroup 调用点：一行）。 */
function beginIfBudgeted(group) {
  const budget = readBudget(group);
  if (budget) begin(group && group.group_id);
  return budget;
}

/** 结算一个任务的 token 用量（任务结束调用；非数字静默忽略，不污染账本）。 */
function addTokens(groupId, tokens) {
  const st = begin(groupId);
  if (!st) return 0;
  const n = Number(tokens);
  if (Number.isFinite(n) && n > 0) st.tokens += n;
  return st.tokens;
}

/** 当前账面（诊断/测试用）。未 begin 过的组返回 null，不侧漏造状态。 */
function snapshotOf(groupId) {
  const st = state.get(groupId);
  if (!st) return null;
  return { startedAt: st.startedAt, tokens: st.tokens, elapsedMs: Date.now() - st.startedAt };
}

/**
 * 判定该组是否已触达预算上限。
 *
 * @param {string} groupId
 * @param {object|null} budget `readBudget()` 的产物；null ⇒ 不设限
 * @returns {{exhausted:boolean, key:string|null, message:string, remainingMs:number}}
 */
function assess(groupId, budget) {
  if (!budget) return { exhausted: false, key: null, message: '', remainingMs: Infinity };
  const st = begin(groupId) || { startedAt: Date.now(), tokens: 0 };
  const elapsed = Date.now() - st.startedAt;
  const remainingMs = Math.max(0, budget.max_wall_ms - elapsed);

  if (elapsed >= budget.max_wall_ms) {
    return {
      exhausted: true,
      key: 'max_wall_ms',
      message: `组预算耗尽：墙钟已达上限 ${budget.max_wall_ms}ms（实际 ${elapsed}ms），不再派生新任务`,
      remainingMs: 0,
    };
  }
  if (st.tokens >= budget.max_tokens) {
    return {
      exhausted: true,
      key: 'max_tokens',
      message: `组预算耗尽：token 已用 ${st.tokens} ≥ 上限 ${budget.max_tokens}，不再派生新任务`,
      remainingMs,
    };
  }
  return { exhausted: false, key: null, message: '', remainingMs };
}

/**
 * 单任务的预算计划（workerPool 在装配 runOpts 前调用一次，结果复用三处）。
 *
 * @param {object} group
 * @param {object} task
 * @param {object} [opts] `{ maxRoundsFallback }` 无预算时的回退轮次（历史值 20）
 * @returns {{hasBudget:boolean, maxRounds:number, timeoutMs:number, settle:Function}}
 */
function planForTask(group, task, opts = {}) {
  const fallback = Number(opts.maxRoundsFallback) > 0 ? Number(opts.maxRoundsFallback) : 20;
  const budget = readBudget(group);
  if (!budget) {
    return {
      hasBudget: false,
      maxRounds: fallback,
      timeoutMs: Number(task && task.timeoutMs) || 0,
      settle: () => {},
    };
  }
  const groupId = group && group.group_id;
  const st = begin(groupId) || { startedAt: Date.now(), tokens: 0 };
  const wallLeft = Math.max(0, budget.max_wall_ms - (Date.now() - st.startedAt));
  const taskTimeout = Number(task && task.timeoutMs) || 0;
  return {
    hasBudget: true,
    maxRounds: budget.max_rounds,
    // 夹到组剩余额度：单任务不可能拖着整组越过 max_wall_ms。下限 1s 防「0 超时」立刻自杀。
    timeoutMs: Math.max(1000, Math.min(taskTimeout || wallLeft, wallLeft)),
    settle: (tokens) => addTokens(groupId, tokens),
  };
}

/**
 * 预算越界处置（workerPool 的泵调用点：一行）。
 * 把该组**尚未开始**的任务确定性置 skipped 并写明原因；在途任务交给它自己的（已被夹紧的）超时。
 *
 * @returns {boolean} true = 本组本轮已停派（调用方 continue）
 */
function tripIfExhausted(deps, group) {
  const budget = readBudget(group);
  if (!budget || !deps || !deps.store) return false;
  const groupId = group.group_id;
  const verdict = assess(groupId, budget);
  if (!verdict.exhausted) return false;

  // 重新取组：listGroups 的投影不保证带 tasks，用 getGroup 拿权威视图。
  const full = deps.store.getGroup(groupId) || group;
  let skipped = 0;
  for (const t of (full.tasks || [])) {
    if (t.status !== 'queued' && t.status !== 'pending') continue;
    try {
      deps.store.setTaskStatus(groupId, t.taskId, 'skipped', { error: verdict.message, force: true });
      skipped += 1;
      deps.emit?.({ type: 'task_update', groupId, taskId: t.taskId, status: 'skipped' });
      deps.emit?.({ type: 'board_task_settled', groupId, taskId: t.taskId, status: 'skipped' });
    } catch (e) {
      console.warn(`[groupBudget] 预算越界置 skipped 失败（${t.taskId}）:`, e.message);
    }
  }
  if (skipped > 0) {
    console.warn(`[groupBudget] ${verdict.message}；已跳过 ${skipped} 个未开始任务`);
    deps.emit?.({ type: 'group_update', groupId, status: 'running', error: verdict.message });
  }
  return true;
}

/** 组收尾清理（防 Map 随长会话无限增长）。 */
function clear(groupId) {
  if (groupId) state.delete(groupId);
}

/** 测试用：清空全部账本。 */
function reset() {
  state.clear();
}

module.exports = {
  readBudget, begin, beginIfBudgeted, addTokens, assess, planForTask,
  tripIfExhausted, snapshotOf, clear, reset,
};

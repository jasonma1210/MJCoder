// P1-5/P1-7：Agent Worker 池——并发执行子任务（信号量限流）+ 组级失败策略
// 设计（计划文档 P1-5/P1-7）：
//   · Worker = 一次 runAgent 调用（复用 agent-core 引擎与主进程工具实现），无状态；
//     并发上限 = 配置项（默认 2），由本池信号量控制——本地/云端资源瓶颈统一入口。
//   · 每任务独立 AbortController + 墙钟超时；失败按 maxRetry 重试（queued 回队）。
//   · 组级策略：非关键失败降级继续；关键失败且阻塞下游 → 组 paused（等待重规划/人工处置）。
//   · 组收尾：无待执行任务 → 聚合 → done（带 warnings）；全部关键失败 → failed。
// 依赖注入（initWorkerPool）：{ loadAgentCore, createToolHandlers, chatOnce, store, emit }
//   loadAgentCore/创建工具处理器/chat 与 main.js 定时任务通道同源。

const { aggregateGroup } = require('./aggregator/merge');
const workerIsolation = require('./workerIsolation');
const { toAgentModel } = require('./modelShape');
const path = require('path');

let deps = null;
let maxConcurrent = 4; // 默认并发 4：主流大模型服务普遍支持 4 路并发请求
// runKey `${groupId}/${taskId}` -> { controller, name, manual }
const activeRuns = new Map();
let pumping = false;

// Worker 可爱命名（Agent 胶囊显示用）：按序分配，避免与在役重名
const WORKER_NAMES = ['布丁', '团子', '芝麻', '汤圆', '糯米', '豆豆', '泡泡', '小橘', '奶盖', '丸子', '椰果', '薯条', '布蕾', '雪饼', '米糕', '茶茶'];
let nameSeq = 0;
function pickWorkerName() {
  const used = new Set([...activeRuns.values()].map((r) => r.name));
  for (let i = 0; i < WORKER_NAMES.length; i += 1) {
    const n = WORKER_NAMES[(nameSeq + i) % WORKER_NAMES.length];
    if (!used.has(n)) { nameSeq = (nameSeq + i + 1) % WORKER_NAMES.length; return n; }
  }
  nameSeq += 1;
  return `小助手${nameSeq}`;
}

function initWorkerPool(d) {
  deps = d;
  maxConcurrent = Math.min(Math.max(Number(d.maxConcurrent) || 4, 1), 8);
}

function setMaxConcurrent(n) {
  maxConcurrent = Math.min(Math.max(Number(n) || 2, 1), 8);
  return maxConcurrent;
}

function getMaxConcurrent() { return maxConcurrent; }
function activeCount() { return activeRuns.size; }

// 启动/推进一个组：循环调度直到组收尾或资源耗尽（后台执行，立即返回组状态）
async function runGroup(groupId) {
  if (!deps) throw new Error('WorkerPool 未初始化');
  const g = deps.store.getGroup(groupId);
  if (!g) throw new Error(`任务组不存在：${groupId}`);
  deps.store.setGroupStatus(groupId, 'running');
  deps.emit?.({ type: 'group_update', groupId, status: 'running' });
  schedule(); // 异步泵；不 await（调用方立即拿回控制权）
  return deps.store.getGroup(groupId);
}

// 调度泵：只要有空闲槽位且组内有 queued 任务就派发；全部槽位占满/无任务则停止。
// 多组并存：从所有 running 组中轮流领取（简单轮转，先到先得）。
function schedule() {
  if (pumping) return;
  pumping = true;
  setImmediate(() => { pumping = false; pump(); });
}

async function pump() {
  if (!deps) return;
  try {
    while (activeRuns.size < maxConcurrent) {
      const groups = deps.store.listGroups({ limit: 50 }).filter((g) => g.status === 'running');
      if (groups.length === 0) break;
      let dispatched = false;
      let allIdle = true;
      for (const g of groups) {
        // 先把依赖已满足的 pending 入队
        deps.store.enqueueReady(g.group_id);
        const task = deps.store.claimNext(g.group_id, `w-${Date.now().toString(36)}`);
        if (task) {
          allIdle = false;
          dispatch(g, task);
          dispatched = true;
          if (activeRuns.size >= maxConcurrent) break;
        }
      }
      if (!dispatched) break; // 无可派发任务（可能都在跑或被阻塞）
      if (allIdle) break;
    }
    // 收尾检查：running 组若已无待执行任务 → 聚合收尾；关键失败阻塞 → 暂停
    const groups = deps.store.listGroups({ limit: 50 }).filter((g) => g.status === 'running');
    for (const g of groups) {
      if (deps.store.isGroupSettled(g.group_id)) {
        finalizeGroup(g.group_id);
      } else if (deps.store.groupHasBlockingFailure(g.group_id)) {
        deps.store.setGroupStatus(g.group_id, 'paused', { error: '关键任务失败且阻塞下游任务，组已暂停（可重试失败任务或取消）' });
        deps.emit?.({ type: 'group_update', groupId: g.group_id, status: 'paused' });
      }
    }
  } catch (e) {
    console.error('[workerPool] 调度异常:', e.message);
  }
}

function dispatch(group, task) {
  const runKey = `${group.group_id}/${task.taskId}`;
  const controller = new AbortController();
  const name = pickWorkerName();
  activeRuns.set(runKey, { controller, name, manual: false, iso: null });
  deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: 'running', title: task.title, name });
  deps.emit?.({ type: 'task_activity', groupId: group.group_id, taskId: task.taskId, name, kind: 'start', text: `${name} 接手任务「${task.title}」` });

  // P1 遗留项落地：真并行隔离——可写任务在独立 worktree 中执行，结束后合并回主目录。
  // 非 git 仓库/创建失败自动回落主目录（不阻塞）；写沙箱为只读时不隔离（无写冲突可能）。
  const wantsIsolation = !!group.cwd && group.sandboxPolicy !== 'read-only';
  (async () => {
    let iso = null;
    if (wantsIsolation) {
      iso = await workerIsolation.createIsolated({ cwd: group.cwd, groupId: group.group_id, taskId: task.taskId });
      if (iso) {
        const entry = activeRuns.get(runKey);
        if (entry) entry.iso = iso;
        deps.emit?.({ type: 'task_activity', groupId: group.group_id, taskId: task.taskId, name, kind: 'start', text: `${name} 在隔离工作区中执行（${path.basename(iso.worktreePath)}）` });
      }
    }
    const runCwd = iso?.worktreePath || group.cwd || '';
    await runWorkerTask({ group, task, runKey, controller, name, runCwd, iso });
  })().catch((e) => {
    // P0-C 修复：此前这个IIFE 是「浮动 Promise」且无 .catch()。
    // runWorkerTask 之外抛出的异常（典型：workerIsolation.createIsolated 失败、
    // deps.emit 抛错等）没有任何人接住 → 冒泡成 unhandledRejection →
    // Electron 主进程默认行为是**直接退出**，用户的全部会话与正在跑的任务一起丢失。
    // 这里兜住：把异常降级为该任务 failed + 组暂停，让用户看到可操作的信息，
    // 而不是整个应用无声消失。
    const msg = String(e?.message || e);
    console.error(`[workerPool] 任务派发异常（任务「${task?.title || task?.taskId}」）:`, msg);
    try {
      activeRuns.delete(runKey);
      deps.store?.setTaskStatus?.(group.group_id, task.taskId, 'failed', { error: `任务执行异常：${msg}` });
      deps.emit?.({
        type: 'task_activity', groupId: group.group_id, taskId: task.taskId, name,
        kind: 'error', text: `任务执行异常：${msg}`,
      });
      // 不静默：组状态置为paused，用户可读可重试；绝不让主进程带病退出
      deps.store?.setGroupStatus?.(group.group_id, 'paused', { error: `任务「${task?.title || task.taskId}」执行异常：${msg}` });
      deps.emit?.({ type: 'group_update', groupId: group.group_id, status: 'paused' });
    } catch (inner) {
      // 连降级处理都失败时只记日志——此处绝不能再抛，否则又回到 unhandledRejection
      console.error('[workerPool] 异常降级处理失败:', String(inner?.message || inner));
    }
  });
}

async function runWorkerTask({ group, task, runKey, controller, name, runCwd, iso }) {
  {
    let result = null;
    let errorMsg = null;
    try {
      const core = await deps.loadAgentCore();
      const handlers = deps.createToolHandlers({ signal: controller.signal });
      // 墙钟超时：到点中止本轮 Agent（工具调用在下一轮 chat 才感知，符合设计取舍）
      const timer = setTimeout(() => controller.abort(new Error(`任务超时（${Math.round(task.timeoutMs / 60000)} 分钟）`)), task.timeoutMs);
      // 活动流：工具调用 → task_activity 事件（Agent 胶囊/面板实时展示执行流程）
      const onToolCall = (tc) => {
        deps.emit?.({
          type: 'task_activity', groupId: group.group_id, taskId: task.taskId, name,
          kind: 'tool', text: `${tc?.name || '工具'} ${summarizeArgs(tc?.args)}`,
        });
      };
      try {
        const finalText = await core.runAgent({
          messages: [{ role: 'user', content: deps.buildTaskPrompt(group, task) }],
          // 2026-10-15 修复：此处原先直接传 deps.resolveModel()（扁平形），而 runAgent
        // 读 model.provider.id（嵌套形）→ 每个子任务第 1 轮即崩
        // `Cannot read properties of undefined (reading 'id')`，整组随后降级/重规划。
        // 转换统一走 modelShape.js，不再各调用链手抄（定时任务路径曾手抄过一份）。
        model: toAgentModel(deps.resolveModel()),
          cwd: runCwd,
          signal: controller.signal,
          approvalMode: 'auto-safe',
          sandboxPolicy: runCwd ? 'workspace-write' : 'read-only',
          conversationId: `task:${group.group_id}:${task.taskId}`,
          maxRounds: 20,
          chatRetryBaseMs: 2000,
          tokenBudget: 200000,
          toolHandlers: handlers,
          onToolCall,
          systemPrompt: '你是 MJ Coder 的并行任务 Worker：只完成分配给你的子任务，产出精炼、可执行的结论。'
            + '完成前必须自测验证：能运行测试/命令验证的就实际运行，写完的文件就回读确认关键内容存在；验证不过要修复后再收尾。'
            + '结束时用一段「summary」总结做了什么、验证结果与关键产物（文件路径等）；不要反问，不要输出无关寒暄。',
        });
        result = { summary: String(finalText || ''), artifacts: extractPaths(finalText) };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      errorMsg = String(err?.message || err);
    }

    const entry = activeRuns.get(runKey);
    activeRuns.delete(runKey);
    try {
      if (entry?.manual) {
        // 强制关闭：不重试，直接终态（用户意图 = 不再跑；不计入自动重试次数）
        deps.store.setTaskStatus(group.group_id, task.taskId, 'failed', { error: '已手动强制关闭', skipRetryCount: true });
        deps.emit?.({ type: 'task_activity', groupId: group.group_id, taskId: task.taskId, name, kind: 'stop', text: `${name} 已被强制关闭` });
        deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: 'failed', error: '已手动强制关闭' });
        if (entry?.iso) await workerIsolation.discardIsolated({ iso: entry.iso });
      } else if (errorMsg != null && result == null) {
        const { retried } = deps.store.handleFailure(group.group_id, task.taskId, errorMsg);
        deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: retried ? 'queued' : 'failed', error: errorMsg });
        maybePauseOnCritical(group.group_id, task, retried);
        if (!retried && entry?.iso) await workerIsolation.discardIsolated({ iso: entry.iso }); // 失败丢弃隔离副本
      } else {
        // Agent 引擎的「未完成收尾」标记（重复失败熔断 / 预算耗尽）→ 任务判 failed，
        // 走失败处置（重试回队 / 关键失败暂停组），不得伪装成 done
        const incomplete = /已主动停止|任务未完全完成/.test(String(result.summary || ''));
        if (incomplete) {
          const { retried } = deps.store.handleFailure(group.group_id, task.taskId, 'Agent 未完成收尾（重复失败熔断或预算耗尽）', { summary: result.summary, artifacts: result.artifacts });
          deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: retried ? 'queued' : 'failed', error: 'Agent 未完成收尾' });
          maybePauseOnCritical(group.group_id, task, retried);
          if (!retried && entry?.iso) await workerIsolation.discardIsolated({ iso: entry.iso });
        } else {
          // 成功：worktree 改动合并回主目录（冲突 → 补丁落盘 + 降级警告）
          let mergeInfo = null;
          if (entry?.iso) {
            mergeInfo = await workerIsolation.mergeBackIsolated({ cwd: group.cwd, iso: entry.iso });
            if (mergeInfo.conflicts) {
              result.warnings = [...(result.warnings || []), `隔离工作区改动合并冲突：${mergeInfo.error}`];
            } else if (mergeInfo.applied) {
              result.warnings = [...(result.warnings || []), '隔离工作区改动已合并回主目录'];
            }
          }
          deps.store.setTaskStatus(group.group_id, task.taskId, 'done', { result });
          deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: 'done' });
        }
      }
    } catch (e) {
      console.error('[workerPool] 结果落库失败:', e.message);
      if (entry?.iso) await workerIsolation.discardIsolated({ iso: entry.iso }).catch(() => {});
    }
    schedule(); // 任务结束后推进调度
  }
}

// 工具参数摘要（活动流展示用）：截断长 JSON，仅保留关键信息
function summarizeArgs(args) {
  try {
    const s = typeof args === 'string' ? args : JSON.stringify(args || {});
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  } catch { return ''; }
}

// 强制关闭指定任务（Agent 胶囊「强制关闭」入口）：中止运行且不重试
function abortTask(groupId, taskId) {
  const runKey = `${groupId}/${taskId}`;
  const entry = activeRuns.get(runKey);
  if (!entry) return false;
  entry.manual = true;
  entry.controller.abort(new Error('已手动强制关闭'));
  return true;
}

// 组级强停（AgentDock「全部停止」/对话中止联动）：中止该组全部在役任务
function abortGroup(groupId) {
  let n = 0;
  for (const [runKey, entry] of activeRuns.entries()) {
    if (runKey.startsWith(`${groupId}/`)) {
      entry.manual = true;
      entry.controller.abort(new Error('已手动强制关闭'));
      n += 1;
    }
  }
  return n;
}

// 当前在役 Worker 快照（Agent 面板兜底刷新用）
function listActive() {
  return [...activeRuns.entries()].map(([runKey, r]) => {
    const [groupId, taskId] = runKey.split('/');
    return { groupId, taskId, name: r.name };
  });
}

// 关键失败处理：不可重试的关键任务 → 若阻塞下游则暂停组（P1-7 组级失败策略）
function maybePauseOnCritical(groupId, task, retried) {
  if (task.critical && !retried) {
    // 立即检查：失败的关键任务是否阻塞下游（下游任务此刻尚未入队执行）
    if (deps.store.groupHasBlockingFailure(groupId)) {
      // 取消还在排队的下游任务（skip），保留已完成结果供重新规划
      const tasks = deps.store.listTasks(groupId);
      for (const t of tasks) {
        if (t.status === 'queued' || t.status === 'pending') {
          try { deps.store.setTaskStatus(groupId, t.taskId, 'skipped'); } catch { /* 状态竞争忽略 */ }
        }
      }
      deps.store.setGroupStatus(groupId, 'paused', { error: `关键任务「${task.title}」失败，下游任务已跳过：组已暂停（可重试失败任务或取消）` });
      deps.emit?.({ type: 'group_update', groupId, status: 'paused', error: `关键任务「${task.title}」失败` });
    }
  }
}

// 组收尾：聚合（代码聚合 v1）→ done / failed
function finalizeGroup(groupId) {
  const g = deps.store.getGroup(groupId);
  if (!g) return;
  const subResults = g.tasks.map((t) => ({
    taskId: t.taskId, title: t.title, critical: t.critical,
    ok: t.status === 'done', result: t.result, error: t.error,
  }));
  const anyCriticalFailed = subResults.some((r) => r.critical && !r.ok);
  const aggregation = aggregateGroup(subResults);
  const result = {
    summary: aggregation.merged.summary,
    artifacts: aggregation.merged.artifacts,
    warnings: aggregation.warnings,
    failed: aggregation.failed.map((f) => ({ taskId: f.taskId, title: f.title, error: f.error })),
  };
  const status = anyCriticalFailed ? 'failed' : 'done';
  deps.store.setGroupStatus(groupId, status, {
    error: anyCriticalFailed ? `存在失败的关键任务（${result.failed.length} 个）` : null,
    result,
  });
  deps.emit?.({ type: 'group_update', groupId, status, result });
  // 终态事件：main 层据此触发 auto 组的自动重规划
  deps.emit?.({ type: 'group_finalized', groupId, status });
}

// 从 Worker 结论文本提取产物文件路径（粗提取：反引号内以 / 或 ./ 开头的路径）
function extractPaths(text) {
  const out = [];
  const re = /`([^`\n]*\/[^`\n]+)`/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const p = m[1];
    if (p.length < 200 && !out.includes(p)) out.push(p);
    if (out.length >= 20) break;
  }
  return out;
}

module.exports = { initWorkerPool, runGroup, setMaxConcurrent, getMaxConcurrent, activeCount, finalizeGroup, schedule, abortTask, abortGroup, listActive };

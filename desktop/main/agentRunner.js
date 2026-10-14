// P0-4：主进程 Agent 运行器——交互式会话的工具循环从渲染进程迁至主进程。
// 背景：此前整个 runAgent 循环跑在渲染进程（renderer/src/lib/agent.js），与 UI 生命周期
// 强耦合：刷新/关闭窗口直接杀死进行中的任务与全部工具副作用；渲染层同时是调度器又是 UI。
// 架构：
//   渲染层 → ipc 'agent:run'（runId + 参数）→ 本模块在主进程跑 agent-core runAgent 循环
//         ← ipc 'agent:event'（{runId, type, data}）事件流回渲染层（message/delta/tool_call/done/error）
//   流式 token 继续走既有 'model:delta' / 'model:reasoning' 通道直达窗口，渲染层流式 UI 零改动。
//   中止：渲染层 AbortSignal → ipc 'agent:abort' → run controller.abort()（引擎优雅收尾）。

// 依赖经 init 注入（避免与 main.js 循环 require）：
//   loadAgentCore: () => Promise<agentCore>          —— ESM 动态 import（main.js 已有）
//   createToolHandlers: ({ sender, signal }) => obj  —— 每次运行的工具处理器（含流式 chat）
let deps = null;

// Phase 3-4：最近一次运行的 token 用量状态（渲染层 AgentDock 仪表盘经 IPC 轮询）
let lastBudgetState = null;

function initAgentRunner(d) {
  deps = d;
}

// runId -> { controller, sender }
const runs = new Map();
let runSeq = 0;

function makeEmitter(sender, runId) {
  return (type, data) => {
    try {
      if (sender && !sender.isDestroyed()) sender.send('agent:event', { runId, type, data });
    } catch (e) {
      console.warn('[agentRunner] 事件推送失败:', e.message);
    }
  };
}

// 启动一次交互式 Agent 运行。立即返回 runId；循环在后台执行，事件经 agent:event 推送。
function startAgentRun(payload, sender) {
  if (!deps) return { ok: false, error: 'AgentRunner 未初始化' };
  runSeq += 1;
  const runId = payload.runId || `run-${Date.now().toString(36)}-${runSeq}`;
  const controller = new AbortController();
  const emit = makeEmitter(sender, runId);
  runs.set(runId, { controller, sender });

  // 后台执行：不 await（IPC handle 需立即返回，渲染层靠事件流驱动 UI）
  (async () => {
    let doneSent = false;
    const startedAt = Date.now();
    console.warn(`[agentRun] 启动 runId=${runId} model=${payload?.model?.model?.model_id || '?'} cwd=${payload?.cwd || '-'} msgs=${payload?.messages?.length || 0} budget=${payload?.tokenBudget || 0}`);
    try {
      const core = await deps.loadAgentCore();
      const handlers = deps.createToolHandlers({ sender, signal: controller.signal });
      const finalText = await core.runAgent({
        messages: payload.messages,
        model: payload.model,
        mcpTools: payload.mcpTools || [],
        enabledSkills: payload.enabledSkills || [],
        skills: payload.skills || [],
        cwd: payload.cwd,
        agentsMd: payload.agentsMd,
        memories: payload.memories || [],
        sandboxPolicy: payload.sandboxPolicy,
        approvalMode: payload.approvalMode || 'on-request',
        planMode: !!payload.planMode,
        conversationId: payload.conversationId,
        tokenBudget: payload.tokenBudget || 0,
        // Phase 3-1：断点恢复上下文（渲染层「继续」时从 checkpointStore 取回注入）
        resumeContext: payload.resumeContext || '',
        signal: controller.signal,
        toolHandlers: handlers,
        onMessage: (m) => emit('message', m),
        onStream: (s) => emit('stream', s),
        onToolCall: (tc) => emit('tool_call', tc),
        // Phase 3-1：token 预算熔断 → 保存断点（threadKey = conversationId）+ 通知渲染层
        onSuspend: (info) => {
          let saved = false;
          try {
            const cp = require('./checkpointStore');
            saved = cp.saveCheckpoint(String(payload.conversationId || 'local'), {
              summary: String(info?.summary || '').slice(-4000),
              usage: info?.usage || null,
              rounds: info?.roundsUsed || 0,
              rescues: info?.rescues || 0,
              budget: info?.budget || 0,
              model: payload?.model?.model?.model_id || '',
              cwd: payload?.cwd || '',
            });
          } catch (e) {
            console.warn('[agentRunner] 断点保存失败:', e.message);
          }
          emit('suspended', { saved, ...info });
          return saved;
        },
        // Phase 3-4：逐轮用量上报 → 缓存最新状态（仪表盘轮询数据源）
        onBudget: (s) => {
          lastBudgetState = { ...s, runId, model: payload?.model?.model?.model_id || '', ts: Date.now() };
        },
        onDone: (ft, usage, aborted) => {
          doneSent = true;
          console.warn(`[agentRun] 完成 runId=${runId} 耗时=${Math.round((Date.now() - startedAt) / 1000)}s aborted=${!!aborted} usage=${usage ? `in=${usage.prompt_tokens}/out=${usage.completion_tokens}` : 'null'} textLen=${(ft || '').length}`);
          emit('done', { finalText: ft, usage, aborted });
        },
      });
      // 兜底：引擎部分退出路径若未触发 onDone（防御性），保证渲染层一定能收到终止事件
      if (typeof finalText === 'string' && !doneSent) {
        console.warn(`[agentRun] 兜底收尾 runId=${runId}（引擎未触发 onDone）：textLen=${(finalText || '').length} aborted=${controller.signal.aborted}`);
        emit('done', { finalText, usage: null, aborted: controller.signal.aborted });
      }
    } catch (err) {
      console.error(`[agentRun] 异常终止 runId=${runId} 耗时=${Math.round((Date.now() - startedAt) / 1000)}s：${String(err?.message || err).slice(0, 400)}`);
      emit('error', String(err?.message || err));
    } finally {
      runs.delete(runId);
    }
  })();

  return { ok: true, runId };
}

// 中止指定运行（渲染层 AbortSignal 触发）
function abortRun(runId) {
  const r = runs.get(runId);
  if (!r) return false;
  console.warn(`[agentRun] 中止请求 runId=${runId}（渲染层信号触发）`);
  r.controller.abort();
  return true;
}

// 中止全部运行（model:abort 停止按钮联动）
function abortAllRuns() {
  const n = runs.size;
  for (const [, r] of runs) r.controller.abort();
  return n;
}

// Phase 3-4：仪表盘数据源（main.js IPC 'agent:token/state' 直接透传）
function getTokenState() {
  return lastBudgetState;
}

module.exports = { initAgentRunner, startAgentRun, abortRun, abortAllRuns, getTokenState };

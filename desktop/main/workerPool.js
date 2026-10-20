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
const { stricterApproval, sandboxTierForCwd } = require('./approvalPolicy');
const path = require('path');
// P2-8 / V-L1：V 层（评估接口）宿主侧编排。P1-2 后本通道**默认 l1**（此前默认 off）：
// L1 是零网络、零边际成本的确定性对账，子任务没有理由不对账；
// L3 由 deps.getVerifyConfig() 显式下发 level='l3' 才可能触发（风险门放行时）。
const verifyRun = require('./verifyRun');
const verifyPolicy = require('./verifyPolicy');

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
  // A1（2026-10-16）：活动流文案改 textKey/textParams，由渲染层按用户语言翻译。
  // 此前五处裸中文经 tasks:event 直出 ⇒ 英文界面漏中文，且 i18n 门禁只扫 renderer/src 抓不到。
  // textParams 携带的是非语言性数据（name/标题/错误详情），title 属用户内容按原样插值。
  deps.emit?.({ type: 'task_activity', groupId: group.group_id, taskId: task.taskId, name, kind: 'start', textKey: 'runtime.workerTakeOver', textParams: { name, title: task.title } });

  // P1 遗留项落地：真并行隔离——可写任务在独立 worktree 中执行，结束后合并回主目录。
  // 非 git 仓库/创建失败自动回落主目录（不阻塞）；写沙箱为只读时不隔离（无写冲突可能）。
  // V04：沙箱档读组内快照（建组时刻的父上下文）；旧组无快照列时按 cwd 推导（兼容旧行为）。
  // D-13：旧组无快照列时的回落走 approvalPolicy 的单点 sandboxTierForCwd（档名唯一出处是
  // shared/rolePolicyData.json）——此前是第三处手抄的 `group.cwd ? 'workspace-write' : 'read-only'`。
  const groupSandboxPolicy = group.sandbox_policy || sandboxTierForCwd(group.cwd);
  const wantsIsolation = !!group.cwd && groupSandboxPolicy !== 'read-only';
  (async () => {
    let iso = null;
    if (wantsIsolation) {
      iso = await workerIsolation.createIsolated({ cwd: group.cwd, groupId: group.group_id, taskId: task.taskId });
      if (iso) {
        const entry = activeRuns.get(runKey);
        if (entry) entry.iso = iso;
        deps.emit?.({ type: 'task_activity', groupId: group.group_id, taskId: task.taskId, name, kind: 'start', textKey: 'runtime.workerInWorktree', textParams: { name, worktree: path.basename(iso.worktreePath) } });
      }
    }
    const runCwd = iso?.worktreePath || group.cwd || '';
    // N5 副作用账本：领取即记 uncertain（该任务可能产生副作用），终态时 resolveEffect。
    // 重启恢复后 uncertain 记录保留 = 「副作用无法确认」清单，随 needsReview 供人工核对。
    deps.store.markEffectUncertain(group.group_id, task.taskId);
    // V06：iso 的后续处置全部经 activeRuns 中的 entry.iso（成功合并/失败归档/显式丢弃），
    // 本函数不再直接持有 iso 形参——避免两处引用漂移。
    await runWorkerTask({ group, task, runKey, controller, name, runCwd, groupSandboxPolicy });
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
        kind: 'error', textKey: 'runtime.workerError', textParams: { msg },
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

async function runWorkerTask({ group, task, runKey, controller, name, runCwd, groupSandboxPolicy }) {
  {
    let result = null;
    let errorMsg = null;
    // P1-9：捕获中止原因——runAgent 被中止后可能带部分产出**正常返回**（不抛错），
    // 此前终态判定只看 summary 里的引擎标记正则，墙钟超时的部分产出被伪装成 done。
    let abortReason = null;
    try {
      const core = await deps.loadAgentCore();
      const rawHandlers = deps.createToolHandlers({ signal: controller.signal, cwd: runCwd });
      // P1-5：Worker 工具调用同样过用户自定义 hooks（preToolUse/postToolUse）——
      // 无人值守不等于可以绕过用户设的校验规则（用户写一次规则，三条通道一致生效）。
      const handlers = deps.toolHooks
        ? deps.toolHooks.wrap(rawHandlers, { cwd: runCwd || '', conversationId: `task:${group.group_id}:${task.taskId}` })
        : rawHandlers;
      // ── P2-8 / V-L1 + P1-2：Worker 通道 V 层（默认 l1；opt-in 经 deps.getVerifyConfig() 升到 l3）──
      // 判定事实来源：ledger（引擎 verify_ledger，经下方 onTrace 收）+ diff（runCwd 的
      // git status，非 git 工作区返回 null → R5 降级 SKIP，不阻断任务）。
      // P1-2：默认档由 off 升为 l1——子任务（编排产出）此前无任何对账，只靠主任务兜底。
      const l3 = typeof deps.l3Target === 'function' ? (deps.l3Target() || {}) : {};
      const vrun = verifyRun.createVerificationRun({
        runId: `worker:${runKey}`,
        conversationId: `task:${group.group_id}:${task.taskId}`,
        cwd: runCwd || '',
        config: (typeof deps.getVerifyConfig === 'function' ? deps.getVerifyConfig() : null),
        emit: null, // Worker 无 agent:event 通道；结果只进 trace + verdicts.jsonl
        defaultLevel: 'l1',
        // P1-2：L3 能力一并接线（风险门触发时才跑）。Worker 是无人值守通道，
        // 需要 l3 的组由 getVerifyConfig() 显式下发 level='l3'（与定时通道同策略）。
        l3Chat: l3.l3Chat || null,
        l3Model: l3.l3Model || null,
        l3Gate: (ctx) => verifyPolicy.shouldRunL3({ ...ctx, trigger: { risk: true, sampleRate: 0 } }),
      });
      controller.signal.addEventListener('abort', () => { abortReason = controller.signal.reason?.message || String(controller.signal.reason || '运行已中止'); }, { once: true });
      // 墙钟超时：到点中止本轮 Agent（工具调用在下一轮 chat 才感知，符合设计取舍）
      const timer = setTimeout(() => controller.abort(new Error(`任务超时（${Math.round(task.timeoutMs / 60000)} 分钟）`)), task.timeoutMs);
      // 活动流：工具调用 → task_activity 事件（Agent 胶囊/面板实时展示执行流程）
      const onToolCall = (tc) => {
        vrun.onToolCall(tc); // V 层旁路（off 时为空操作）：缓存最近一次测试命令输出
        deps.emit?.({
          type: 'task_activity', groupId: group.group_id, taskId: task.taskId, name,
          kind: 'tool', text: `${tc?.name || ''} ${summarizeArgs(tc?.args)}`.trim(),
        });
      };
      // T1-3/T1-4：子任务 token 用量累计（写入 result.tokensUsed，渲染层子任务树节点角标）。
      // 与 spawn_subagent 同口径：usage 缺失时按内容长度估算（≈4 字符/token + 每次调用 60）。
      let usedTokens = 0;
      const onUsage = (m) => {
        if (m?.role !== 'assistant') return;
        const reported = (m.tokens_input || 0) + (m.tokens_output || 0);
        const estimated = reported > 0 ? 0
          : Math.ceil(String(m.content || '').length / 4)
            + (Array.isArray(m.tool_calls) ? m.tool_calls.length * 60 : 0);
        usedTokens += reported + estimated;
      };
      try {
        // P1-11b：任务-模型分档（**可选 + 回落**）。`modelOverrides.worker` 缺省、形状不全或任何异常
        // → 静默回落主模型（分档是成本优化，绝不能让配置错误把整组 Worker 弄崩）。
        // 注意形态：基线**必须**保持 `model: toAgentModel(deps.resolveModel())` 这一行
        //（test/model-shape.test.js 的源码护栏即此语义），分档在其后覆盖。
        let workerOv = null;
        if (typeof deps.getModelOverrides === 'function') {
          const slot = (deps.getModelOverrides() || {}).worker;
          if (slot && slot.model) {
            if (slot.providerId) workerOv = slot;
            else console.warn('[workerPool] modelOverrides.worker 缺少 providerId，已回落主模型');
          }
        }
        const runOpts = {
          messages: [{ role: 'user', content: await deps.buildTaskPrompt(group, task) }],
          // 2026-10-15 修复：此处原先直接传 deps.resolveModel()（扁平形），而 runAgent
        // 读 model.provider.id（嵌套形）→ 每个子任务第 1 轮即崩
        // `Cannot read properties of undefined (reading 'id')`，整组随后降级/重规划。
        // 转换统一走 modelShape.js，不再各调用链手抄（定时任务路径曾手抄过一份）。
        model: toAgentModel(deps.resolveModel()),
          cwd: runCwd,
          signal: controller.signal,
          // P0 治理修复（2026-10-16）：原为硬编码 'auto-safe'，后改为读全局「最近一次会话审批档」。
          // V04 修复：子任务权限取「建组时刻的组内快照」（deps.getApprovalMode 仅作旧组兼容回退），
          // 会话中途改审批档不再串到已在排队的组；再与 auto-safe 地板取更严者
          //（never/full-access 是危险组合，有意抬升，UI 需明示生效值）。
          // V04 沙箱：读组内快照，且不允许 worktree 存在把只读父组抬成 workspace-write。
          approvalMode: stricterApproval(group.approval_mode || deps.getApprovalMode?.() || 'on-request', 'auto-safe'),
          sandboxPolicy: runCwd ? groupSandboxPolicy : 'read-only',
          conversationId: `task:${group.group_id}:${task.taskId}`,
          maxRounds: 20,
          chatRetryBaseMs: 2000,
          tokenBudget: 200000,
          // Worker 也是无人值守：收尾文案不能出现「发送继续」
          unattended: true,
          toolHandlers: handlers,
          onToolCall,
          // P2-8 / V-L1：只为收 verify_ledger（其余 trace 事件本通道不落盘，保持零额外写盘）
          // sub:true 是子代理（spawn_subagent）的事件 —— 那批工具调用属于子代理自己的 run，
          // 若混进 worker 的台账，L1 会把「子代理跑过测试」算成「worker 跑过测试」（R2 假绿）。
          onTrace: (evt) => { if (evt && !evt.sub) vrun.onLedger(evt); },
          onMessage: onUsage,
          systemPrompt: '你是 MJ Coder 的并行任务 Worker：只完成分配给你的子任务，产出精炼、可执行的结论。'
            + '完成前必须自测验证：能运行测试/命令验证的就实际运行，写完的文件就回读确认关键内容存在；验证不过要修复后再收尾。'
            + '结束时用一段「summary」总结做了什么、验证结果与关键产物（文件路径等）；不要反问，不要输出无关寒暄。',
        };
        // P1-11b：分档覆盖基线模型（形状异常 → 保持主模型）
        if (workerOv) {
          try {
            runOpts.model = toAgentModel(workerOv);
          } catch (e) {
            console.warn('[workerPool] modelOverrides.worker 形状不可用，已回落主模型:', e.message);
            workerOv = null;
          }
        }
        // P0-3①：思考强度随模型透传——agent-core 从 `model.model.reasoning_effort` 取，再下发到
        // 非流式通道的 `reasoning_effort`。分档自带则用分档的，否则沿用主模型（resolveModel 是纯 getter）。
        const effortSrc = workerOv || deps.resolveModel();
        const effort = effortSrc.reasoningEffort || effortSrc.reasoning_effort || '';
        if (effort) runOpts.model = { ...runOpts.model, model: { ...runOpts.model.model, reasoning_effort: effort } };
        const finalText = await core.runAgent(runOpts);
        // P2-8 / V-L1：off 时 finish 直接返回原文（零行为变化）；开启后 BLOCK 只在
        // summary 末尾追加对账提示——**不改变任务成败判据**（改判据会让无人值守任务
        // 因为一句自述措辞反复重试，成本远大于收益；是否升级为失败留给后续批次决定）。
        // try/catch 是硬要求：V 层任何故障都绝不能把任务翻成 failed（那等于让「评估器」
        // 有权判死一个其实已完成的任务，是本次改造最不能接受的副作用）。
        let summaryText = finalText;
        try {
          const vr = await vrun.finish(finalText);
          if (typeof vr?.finalText === 'string') summaryText = vr.finalText;
        } catch (e) {
          console.warn('[workerPool] V 层判定异常（不影响任务结果）:', e?.message || e);
        }
        result = { summary: String(summaryText || ''), artifacts: extractPaths(summaryText), tokensUsed: usedTokens };
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
        deps.emit?.({ type: 'task_activity', groupId: group.group_id, taskId: task.taskId, name, kind: 'stop', textKey: 'runtime.workerForceStopped', textParams: { name } });
        deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: 'failed', error: '已手动强制关闭' });
        // V06：强制关闭也先归档——有改动保留现场，无改动才清理
        await archiveIsoIfNeeded(entry, group, task, '已手动强制关闭');
      } else if (errorMsg != null && result == null) {
        const { retried } = deps.store.handleFailure(group.group_id, task.taskId, errorMsg);
        deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: retried ? 'queued' : 'failed', error: errorMsg });
        maybePauseOnCritical(group.group_id, task, retried);
        // V06：不再无条件丢弃隔离副本——将重试（新副本覆盖）才清理；终态失败先归档保留产物
        if (retried) { if (entry?.iso) await workerIsolation.discardIsolated({ iso: entry.iso }).catch(() => {}); }
        else await archiveIsoIfNeeded(entry, group, task, errorMsg);
      } else if (abortReason != null) {
        // P1-9：超时/外部中止不得判 done——带部分产出正常返回也按失败落库（不重试：
        // 墙钟超时自动重试会再烧一整轮，改由用户核对后手动重试；重试次数不消耗）。
        deps.store.setTaskStatus(group.group_id, task.taskId, 'failed', {
          error: abortReason, skipRetryCount: true,
          result: result ? { summary: result.summary, artifacts: result.artifacts, tokensUsed: result.tokensUsed, partial: true } : null,
        });
        deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: 'failed', error: abortReason });
        maybePauseOnCritical(group.group_id, task, false); // 关键任务超时同样按失败暂停组（下游不再空跑）
        await archiveIsoIfNeeded(entry, group, task, abortReason);
      } else {
        // Agent 引擎的「未完成收尾」标记（重复失败熔断 / 预算耗尽）→ 任务判 failed，
        // 走失败处置（重试回队 / 关键失败暂停组），不得伪装成 done
        const incomplete = /已主动停止|任务未完全完成/.test(String(result.summary || ''));
        if (incomplete) {
          const { retried } = deps.store.handleFailure(group.group_id, task.taskId, 'Agent 未完成收尾（重复失败熔断或预算耗尽）', { summary: result.summary, artifacts: result.artifacts });
          deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: retried ? 'queued' : 'failed', error: 'Agent 未完成收尾' });
          maybePauseOnCritical(group.group_id, task, retried);
          if (retried) { if (entry?.iso) await workerIsolation.discardIsolated({ iso: entry.iso }).catch(() => {}); }
          else await archiveIsoIfNeeded(entry, group, task, 'Agent 未完成收尾');
        } else {
          // 成功：worktree 改动合并回主目录
          let mergeInfo = null;
          if (entry?.iso) {
            mergeInfo = await workerIsolation.mergeBackIsolated({ cwd: group.cwd, iso: entry.iso });
          }
          // V06：合并成功（或无隔离）才允许 done；冲突/失败 → needs_review 语义
          //（终态 failed + error 指明补丁与 worktree 位置），绝不「清理后标完成」。
          if (mergeInfo && !mergeInfo.ok) {
            const detail = mergeInfo.error || '隔离工作区改动合并失败';
            deps.store.setTaskStatus(group.group_id, task.taskId, 'failed', {
              error: `成果待人工审查（needs_review）：${detail}`,
              result: {
                summary: result.summary,
                artifacts: result.artifacts,
                tokensUsed: result.tokensUsed,
                needsReview: true,
                patchFile: mergeInfo.patchFile || null,
                worktreePath: mergeInfo.worktreePath || null,
              },
              skipRetryCount: true, // 合并失败不是 Agent 失败，不消耗自动重试次数（避免重跑覆盖已有成果）
            });
            deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: 'failed', error: `成果待人工审查：${detail}`, needsReview: true });
            maybePauseOnCritical(group.group_id, task, false);
          } else {
            if (mergeInfo?.applied) {
              result.warnings = [...(result.warnings || []), '隔离工作区改动已合并回主目录'];
            }
            deps.store.setTaskStatus(group.group_id, task.taskId, 'done', { result });
            deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: 'done' });
          }
        }
      }
    } catch (e) {
      console.error('[workerPool] 结果落库失败:', e.message);
      // V06：落库失败也不静默销毁产物——先归档再吞异常
      await archiveIsoIfNeeded(entry, group, task, `结果落库失败：${e.message}`).catch(() => {});
    }
    // N5 副作用账本：任务到达终态（done / failed / skipped，含 needsReview 分支）→ resolved。
    // needsReview 的 needsReview 标记在任务 result 里，账本只管「该任务已终态、副作用清单已定」。
    try { deps.store.resolveEffect(group.group_id, task.taskId); } catch (e) { console.warn('[workerPool] 副作用账本 resolve 失败:', e.message); }
    schedule(); // 任务结束后推进调度
  }
}

// V06：失败/中止路径的隔离副本归档——有改动保留现场（worktree+补丁路径写进任务结果），无改动才清理
async function archiveIsoIfNeeded(entry, group, task, reason) {
  if (!entry?.iso) return;
  try {
    const archived = await workerIsolation.archiveIsolated({ iso: entry.iso });
    if (!archived.empty) {
      try {
        deps.store.setTaskStatus(group.group_id, task.taskId, 'failed', {
          error: `${reason}（改动未丢失，待人工审查：补丁 ${archived.patchFile || '未生成'}，worktree ${archived.worktreePath}）`,
          result: { needsReview: true, patchFile: archived.patchFile || null, worktreePath: archived.worktreePath || null },
          skipRetryCount: true,
        });
      } catch (e) {
        // 状态已终态/迁移非法时保留日志：产物仍在 worktree 与补丁目录，不因落库失败而销毁
        console.warn('[workerPool] needs_review 状态写入失败（产物已保留）:', e.message);
      }
      deps.emit?.({ type: 'task_update', groupId: group.group_id, taskId: task.taskId, status: 'failed', error: reason, needsReview: true });
    }
  } catch (e) {
    console.warn('[workerPool] 隔离副本归档失败（保留现场）:', e.message);
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
// P1-8：排队中的任务一并处置——此前只中止在役 run，queued/pending 任务再无 Worker
// 认领却永远留在 queued，组收尾判定「无待执行任务」永不成立，「全部停止」后界面永久转圈。
// 统一置 skipped（终态、错误信息可读），组置 cancelled；返回值保持为在役中止数（IPC 兼容）。
function abortGroup(groupId) {
  let n = 0;
  for (const [runKey, entry] of activeRuns.entries()) {
    if (runKey.startsWith(`${groupId}/`)) {
      entry.manual = true;
      entry.controller.abort(new Error('已手动强制关闭'));
      n += 1;
    }
  }
  let skipped = 0;
  try {
    for (const t of deps.store.listTasks(groupId)) {
      if (t.status === 'queued' || t.status === 'pending') {
        try {
          deps.store.setTaskStatus(groupId, t.taskId, 'skipped', { error: '组已被用户强制停止', force: true });
          skipped += 1;
        } catch (e) {
          console.warn(`[workerPool] 组停时任务 ${t.taskId} 置 skipped 失败:`, e.message);
        }
      }
    }
    deps.store.setGroupStatus(groupId, 'cancelled', { error: '已被用户强制停止' });
    deps.emit?.({ type: 'group_update', groupId, status: 'cancelled', error: '已被用户强制停止' });
  } catch (e) {
    console.warn(`[workerPool] 组 ${groupId} 强停收尾失败:`, e.message);
  }
  if (skipped > 0) console.warn(`[workerPool] 组 ${groupId} 强停：在役中止 ${n}，排队跳过 ${skipped}`);
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
            // 原为 `catch { /* 状态竞争忽略 */ }`——纯空吞。
            // setTaskStatus 对非法迁移会 throw，吞掉后该任务永远停在 queued，
            // 而组的收尾判定依赖「无待执行任务」⇒ 组永不能收尾、界面一直转圈。
            // 现按「是否仍在运行」区分处理：仍在运行 = 正常竞争，记 debug；
            // 仍在但被吞 = 异常，显式记录并强制置为 skipped 以保证组可收尾。
            try {
              deps.store.setTaskStatus(groupId, t.taskId, 'skipped');
            } catch (e) {
              const stillPending = deps.store.getTask?.(groupId, t.taskId)?.status;
              if (stillPending === 'queued' || stillPending === 'pending') {
                console.error(`[workerPool] 子任务 ${t.taskId} 标记 skipped 失败且状态未推进`
                  + `（${stillPending}）：${e.message}；强制置为 skipped 以免组无法收尾`);
                try { deps.store.setTaskStatus(groupId, t.taskId, 'skipped', { force: true }); }
                catch (e2) { console.error(`[workerPool] 强制置 skipped 仍失败：${e2.message}`); }
              } else {
                console.warn(`[workerPool] 子任务 ${t.taskId} 状态竞争（已为 ${stillPending}），忽略`);
              }
            }
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

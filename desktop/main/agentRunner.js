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
const runTrace = require('./runTrace');
// T3-1：大工具结果卸载——tool_call 事件超限字段落临时文件，IPC 只传句柄
const bigPayload = require('./bigPayload');
// P2-8 / V-L1：V 层（评估接口）宿主编排——L1 日志对账 + annotate（不续跑、零额外模型调用）
const verifyRun = require('./verifyRun');
// P1-1：V 层触发策略（纯函数）——决定「这一轮值不值得多花一次 L3 模型调用」
const verifyPolicy = require('./verifyPolicy');
// v1（2026-10-19）：意图驱动的 MCP 动态加载（原生优先）——离线规则词典判定本轮诉求能力，
// 仅对「原生未覆盖」的能力按需连接用户已保存的连接器，把其工具并入本轮 mcpTools。
const intentMcp = require('./intentMcpPrewarm');
// N9：治理命中率观测——意图预热的 runs/targets/connected/toolsAdded/misses 计数落点。
const { governanceStats } = require('./governanceStats');

// T0-2：IPC 边界契约（单一事实来源 shared-ipc/contract.mjs）。
// Electron 主进程是 CJS 且 Node 20 无法同步 require ESM，沿用 loadAgentCore 的动态 import 模式：
// 模块加载即启动导入，应用启动到首次用户发起运行之间有大量余量。
// V23（2026-10-16）：加载失败从「降级透传」改为 **fail-closed**——
// 此前契约缺失时校验静默失效（打包白名单漏掉 shared-ipc 时运行时无任何边界），
// 类型门禁通过不等于运行边界存在；现契约不可用即拒绝启动运行。
let contract = null;
let contractFailed = false;
const contractReady = import('../shared-ipc/contract.mjs')
  .then((m) => { contract = m; })
  .catch((e) => {
    contractFailed = true;
    console.error('[agentRunner] IPC 契约加载失败（fail-closed，Agent 运行将被拒绝）:', e.message);
  });
function agentRunnerReady() { return contractReady; }
let deps = null;

// Phase 3-4：最近一次运行的 token 用量状态（渲染层 AgentDock 仪表盘经 IPC 轮询）
let lastBudgetState = null;

// T4-3：角色模板钳制——审批档与沙箱一律取「角色声明与用户设置中更严格者」，
// 角色只能收紧、绝不能放宽（未知值按默认档 on-request / workspace-write 参与比较，不放大权限）。
// 2026-10-16：原为下方两个模块私有函数，Worker 路径拿不到而硬编码 'auto-safe'，
// 导致用户选「全部询问」时子任务仍自动放行（产品对用户设置撒谎）。
// 现抽到 approvalPolicy.js 作为唯一事实源，本文件与 workerPool.js 共用，杜绝再次分叉。
const { stricterApproval, stricterSandbox } = require('./approvalPolicy');
// G-CUA：无人值守/交互路径的「界面自动化 opt-in」来源——与审批档/沙箱同源（用户设置）。
const approvalSettings = require('./approvalSettings');

// 用户最近一次选择的审批档。Worker 子任务经 deps.getApprovalMode() 读它来继承用户设置。
// 不做持久化：这是「本会话的当前选择」，重启后回到默认档是正确行为。
let currentUserApprovalMode = 'on-request';
// 2026-10-17（P1-1）：按 runId 存本次运行的审批档。
// 为什么需要它：审批档可**按会话覆盖**（渲染层 thread.approval_mode），所以「最后一次 run 的档」
// 不能代表「发起这次编排的那次 run 的档」。编排组快照要用本 run 的档，就必须能按 runId 查。
const runApprovalModes = new Map();

function initAgentRunner(d) {
  deps = d;
}

// P0-1：取本轮最后一条用户消息作为「任务」描述（渲染层 messages 末条 user = 本轮诉求）。
// 只用于记忆条目的任务摘要，截断 300 字符——记忆是召回用的，不需要完整原文。
function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'user') {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      return c.replace(/\s+/g, ' ').trim().slice(0, 300);
    }
  }
  return '';
}

// runId -> { controller, sender }
const runs = new Map();
let runSeq = 0;

// v1（2026-10-19）：意图驱动 MCP 预热的单服务连接上限。用户诉求通常在句首/键位附近，
// 这里取本轮**最后一条 user 消息**前 2000 字符做离线判定（比记忆摘要的 300 字符宽，足以覆盖格式词）。
const INTENT_TEXT_LIMIT = 2000;
// 单个连接器的连接等待上限（冷启动要拉包/起进程，但绝不能让本轮启动被 MCP 拖住）。
const PREWARM_CONNECT_TIMEOUT_MS = 6000;

function latestUserText(messages, limit = INTENT_TEXT_LIMIT) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'user') {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      return c.replace(/\s+/g, ' ').trim().slice(0, limit);
    }
  }
  return '';
}

/** 带超时的 promise 包装：到点即回落（底层连接继续在后台收敛，后续调用仍可经 connect-on-demand 命中）。 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: `意图预热连接超时（${ms}ms）` }), ms)),
  ]);
}

// v1：意图驱动的 MCP 动态加载（原生优先）。返回「本轮需要额外并入 mcpTools 的工具定义」。
// 设计要点：
//   · 原生优先——意图命中的能力若已被原生工具覆盖，直接跳过 MCP（同 run 两种实现永不同框，防冲突）；
//   · 只连用户**已保存**的连接器（本模块不新建任何 MCP 服务）；已在本轮 mcpTools 中的服务不重复连；
//   · fail-open——任一连接失败/超时都只告警，绝不影响本轮运行（工具缺失可经 connect-on-demand 后续补上）；
//   · 有界并发 + 单服务超时，保证本轮启动不被 MCP 冷启动拖住。
async function intentPrewarmToolDefs(payload) {
  const md = deps && deps.mcpDynamic;
  if (!md || typeof md.reconnectSaved !== 'function' || typeof md.loadConfig !== 'function') return [];
  const text = latestUserText(payload && payload.messages);
  if (!text) return [];
  const savedConfigs = md.loadConfig() || [];
  if (!savedConfigs.length) return [];
  const manifests = {};
  for (const cfg of savedConfigs) {
    const name = cfg && cfg.name;
    if (!name || typeof md.getManifest !== 'function') continue;
    const mf = md.getManifest(name);
    if (mf && Array.isArray(mf.tools)) manifests[name] = mf.tools;
  }
  const plan = intentMcp.planPrewarm(text, savedConfigs, manifests);
  // N9 观测：区分「本轮根本没命中意图」与「命中了但全被原生工具覆盖」——二者都返回 []，
  // 但含义完全不同（前者是正常闲聊，后者恰好证明原生优先规则在生效）。
  if (!plan.capabilities.length) { governanceStats.incr('intentPrewarm', 'noIntent'); return []; }
  if (!plan.servers.length) { governanceStats.incr('intentPrewarm', 'nativeCovered'); return []; }
  governanceStats.incr('intentPrewarm', 'runs');
  governanceStats.incr('intentPrewarm', 'capabilities', plan.capabilities.length);
  // 已在本轮 mcpTools 中的服务（渲染层已重建）无需重复连接——只补「有意图但未连接」的落差。
  const already = new Set((payload.mcpTools || [])
    .map((t) => String((t && t.function && t.function.name) || '').split('__')[1])
    .filter(Boolean));
  const targets = plan.servers.filter((n) => !already.has(n));
  // 命中的连接器已全部在场 → 本轮无需新连（与「没有匹配的连接器」不同，单独计数）。
  if (!targets.length) { governanceStats.incr('intentPrewarm', 'satisfied'); return []; }
  governanceStats.incr('intentPrewarm', 'targets', targets.length);
  const results = await Promise.all(targets.map((name) => withTimeout(
    Promise.resolve(md.reconnectSaved(name)).catch((e) => ({ ok: false, error: e && e.message ? e.message : String(e) })),
    PREWARM_CONNECT_TIMEOUT_MS,
  )));
  // N5：工具定义构造统一取自 shared/mcpToolDefs.mjs（与渲染层同一实现）。
  const { sortedToolDefs } = await intentMcp.loadMcpToolDefs();
  const entries = [];
  targets.forEach((name, i) => {
    const r = results[i];
    if (r && r.ok && Array.isArray(r.tools) && r.tools.length) {
      entries.push({ server: name, tools: r.tools });
    } else {
      governanceStats.incr('intentPrewarm', 'misses'); // N9：连接失败（fail-open 但要让观测看得见）
      console.warn(`[agentRun] 意图预热 MCP 连接失败（fail-open，本轮继续） ${name}: ${(r && r.error) || 'unknown'}`);
    }
  });
  // G9：按「服务名 → 工具名」稳定排序后再展开为定义，保证相同配置下披露序列字节稳定（前缀缓存友好）。
  const defs = sortedToolDefs(entries);
  governanceStats.incr('intentPrewarm', 'connected', entries.length); // N9：真连上的服务数
  if (defs.length) {
    governanceStats.incr('intentPrewarm', 'toolsAdded', defs.length); // N9：实际并入本轮的工具定义数
    console.log(`[agentRun] 意图驱动 MCP 预热：capabilities=[${plan.capabilities.join(',')}] 已连接=[${targets.join(',')}] 工具数=${defs.length}`);
  }
  return defs;
}

function makeEmitter(sender, runId) {
  return (type, data) => {
    try {
      // T0-2：发送前契约校验——非法载荷不静默丢弃，降级为同 runId 的 error 事件
      //（渲染层至少能看见「边界拒绝了什么」），可定位字段漂移而不是运行时 TypeError。
      const envelope = { runId, type, data: type === 'tool_call' ? bigPayload.offloadToolCall(runId, data) : data };
      const safe = contract ? contract.safeAgentEventEnvelope(envelope) : envelope;
      if (sender && !sender.isDestroyed()) sender.send('agent:event', safe);
    } catch (e) {
      console.warn('[agentRunner] 事件推送失败:', e.message);
    }
  };
}

// X8：IPC 入口专用——先等契约模块就绪（ESM 动态 import 的启动窗口）再进 startAgentRun。
// agentRunnerReady() 在「加载成功」与「加载失败」两种情况下都会 resolve，
// 失败由 startAgentRun 内的 contractFailed 分支给出可读错误。
// 放在本文件而非 main.js：它属于「IPC 入口 + 契约就绪门」这条链路，与 main.js 的装配职责无关。
async function startAgentRunWhenReady(payload, sender) {
  await contractReady;
  return startAgentRun(payload, sender);
}

// 启动一次交互式 Agent 运行。立即返回 runId；循环在后台执行，事件经 agent:event 推送。
function startAgentRun(payload, sender) {
  if (!deps) return { ok: false, error: 'AgentRunner 未初始化' };
  // V23：契约模块缺失 = IPC 边界不存在，拒绝运行（fail-closed），绝不静默透传
  if (contractFailed) {
    return { ok: false, error: 'IPC 契约模块不可用（shared-ipc/contract.mjs 加载失败），已拒绝启动（fail-closed）。请检查应用安装完整性或重新安装。' };
  }
  // 2026-10-16：记录用户本轮选择的审批档，供 Worker 子任务继承。
  // 子任务此前硬编码 auto-safe ⇒ 用户选「全部询问」时，编排里每条命令仍自动放行，
  // 即产品对用户的设置撒谎。只取「用户设置」，不取 rolePreset 钳制后的值——
  // 钳制已在本文件内对前台生效，Worker 侧还会再叠一层 auto-safe 地板。
  // 本 run 的档：只用于本 run 内的审批判定与「回看最近一次」。**不要**给无人值守路径用，
  // 那边一律走 main/approvalSettings.js 的 getUserApprovalMode()（用户设置）。
  const runApprovalMode = payload.approvalMode || 'on-request';
  currentUserApprovalMode = runApprovalMode;
  // X8：契约未就绪 = 边界不存在，一律拒绝（此前是「未就绪则跳过校验」，
  // 冷启动窗口内畸形载荷可穿透到引擎）。IPC 入口已先 await agentRunnerReady()，
  // 正常路径不会走到这里；保留这道判断是为了让**任何直连调用**也 fail-closed。
  if (!contract) {
    return { ok: false, error: 'IPC 契约尚未就绪，已拒绝启动（fail-closed）。请稍后重试或重启应用。' };
  }
  // T0-2：启动载荷边界校验（fail-closed）——缺 messages/model 或 model 扁平形
  // 直接拒绝启动并给出期望形状（畸形 payload 若放过会深入引擎才炸 TypeError）。
  {
    const v = contract.validateAgentRunPayload(payload);
    if (!v.ok) {
      console.warn(`[agentRunner] 启动被 IPC 契约拒绝：${v.error}`);
      return { ok: false, error: `Agent 启动被拒绝（IPC 契约）：${v.error}` };
    }
  }
  runSeq += 1;
  const runId = payload.runId || `run-${Date.now().toString(36)}-${runSeq}`;
  const controller = new AbortController();
  const emit = makeEmitter(sender, runId);
  runs.set(runId, { controller, sender });
  runApprovalModes.set(runId, runApprovalMode);

  // 后台执行：不 await（IPC handle 需立即返回，渲染层靠事件流驱动 UI）
  (async () => {
    let doneSent = false;
    const startedAt = Date.now();
    console.warn(`[agentRun] 启动 runId=${runId} model=${payload?.model?.model?.model_id || '?'} cwd=${payload?.cwd || '-'} msgs=${payload?.messages?.length || 0} budget=${payload?.tokenBudget || 0}`);
    // ── P2-8 / V-L1（J2）+ P1-1：主对话通道 V 层装配 ──
    // P1-1 后宿主默认档为 'l3'（L1 全量 + 风险门触发时才跑 L3），渲染层仍可用
    // payload.verification 覆盖成 'off' / 'l1' / 'l3'。本通道判定所需的两个事实：ledger
    //（引擎 verify_ledger trace，双执行路径都经 onTrace 到达）与 diff（主进程 git status，
    //  失败即 null → R5 降级 SKIP）。
    // P1-1：L3 独立评审目标（紧凑档优先、回落主模型）——延迟到调用时解析（配置可变）。
    // 与定时通道共用同一目标工厂：guardrail 本质是分类任务，不需要前沿模型，故优先便宜档。
    const l3 = typeof deps.l3Target === 'function' ? (deps.l3Target() || {}) : {};
    const vrun = verifyRun.createVerificationRun({
      runId,
      conversationId: payload.conversationId || '',
      cwd: payload.cwd || '',
      // 只取渲染层可配的字段：stopHookActive 是**宿主注入**的防死循环标志（设计 §5.1），
      // 渲染层不得设置——否则界面可以静默关掉本轮的判定。J2 尚未实现续跑，
      // 因此此处恒为 false；J3 实现 continue 时由宿主在发起续跑时置真。
      config: payload.verification
        ? { ...payload.verification, stopHookActive: false }
        : null,
      emit,
      // P1-1：宿主默认档由 'l1' 升为 'l3' —— L1 确定性对账照旧**全量跑**（零网络、零边际成本）；
      // L3 只在**风险门**（本轮产生对外/不可逆动作）放行时才多花一次模型调用。
      // 渲染层若显式下发 verification.level，仍以渲染层为准（config 覆盖 defaultLevel）。
      defaultLevel: 'l3',
      l3Chat: l3.l3Chat || null,
      l3Model: l3.l3Model || null,
      // 风险门：仅命中 external/不可逆动作才跑 L3；**不抽样**——抽样是度量手段，
      // 交互通道人就在屏幕前，不该为度量引入每次运行都可能发生的额外模型成本。
      l3Gate: (ctx) => verifyPolicy.shouldRunL3({ ...ctx, trigger: { risk: true, sampleRate: 0 } }),
    });
    // 2026-10-15 修复：会话消息持久化收归主进程（此前由渲染层 onMessage/onDone 回调落库）。
    // 事故链：长任务（17min/675k tokens）运行期间渲染层刷新/重载 → 订阅与回调随页面销毁 →
    // 中间消息与**最终总结**全部不落库，任务「偷偷消失」；渲染层 onDone 里 await sendMessage
    // 抛错也会静默跳过 UI 追加与结束信息条（双重丢总结）。
    // 现在主进程直写 localStore：刷新/切走/渲染层异常都丢不了总结。
    // V08：持久 ACK 真实化——persistChatMessage 返回真实结果；失败绝不能宣称已保存。
    const persistChatMessage = (m) => {
      if (!deps.persistMessage || !payload.conversationId) return false;
      try {
        deps.persistMessage({ conversationId: payload.conversationId, message: m });
        return true;
      } catch (e) {
        console.warn(`[agentRun] 消息持久化失败 runId=${runId} role=${m?.role}:`, e.message);
        return false;
      }
    };
    // V08：durable 确认——落库后强制刷盘，只有磁盘 durable 成功才算 mainPersisted:true
    const confirmDurable = (accepted) => {
      if (!accepted) return { persisted: false, state: 'failed' };
      try {
        if (typeof deps.flushPersistence === 'function') {
          const r = deps.flushPersistence();
          return (r && r.ok) ? { persisted: true, state: 'durable' } : { persisted: false, state: 'pending' };
        }
        return { persisted: true, state: 'durable' }; // 无 flush 通道时维持旧语义（落库即接受）
      } catch (e) {
        console.warn(`[agentRun] durable 刷盘失败 runId=${runId}:`, e.message);
        return { persisted: false, state: 'pending' };
      }
    };
    const toStoreShape = (m) => ({
      role: m.role,
      content: m.content || '',
      toolCalls: m.tool_calls || null,
      toolCallId: m.tool_call_id || null,
      tokensInput: m.tokens_input || 0,
      tokensOutput: m.tokens_output || 0,
    });
    // ── P0-1 / P0-2（记忆写入闭环）：宿主侧记忆归档 ──
    // 空间键取**项目路径**而非 cwd：cwd 在 worktree 模式下是临时隔离目录（每次运行一个），
    // 按它归档会把记忆散进一次性空间、永不被召回；召回侧（ChatArea / Worker）一律用项目路径作 spaceId。
    // 落库统一经 MemoryManager 唯一入口（deps.rememberMemory），失败只告警、绝不影响运行结果。
    const memorySpaceId = payload.projectPath || payload.cwd || 'default';
    const archiveMemory = (args) => {
      try {
        return (deps.rememberMemory && deps.rememberMemory({
          spaceId: memorySpaceId,
          // 三层记忆 M0：绑定本会话（L1 会话作用域的归属键）；非会话层由 remember 内部解绑
          conversationId: payload.conversationId || null,
          ...args,
        })) || null;
      } catch (e) {
        console.warn(`[agentRun] 记忆归档失败（不影响运行） runId=${runId}:`, e.message);
        return null;
      }
    };
    // P0-1 收纳判据：本轮是否真有工具执行（纯闲聊不写记忆）。onToolCall 逐条累加。
    let toolCallCount = 0;
    // v1（2026-10-19）：意图驱动的 MCP 动态加载——在组装 engineParams **之前**、有界等待完成。
    // 位置有意选在此处：此处已能拿到本轮会话文本（payload.messages）与主进程 mcp 能力，
    // 且尚未把 mcpTools 交给引擎；失败 fail-open 返回空数组，绝不阻塞本轮启动。
    // N5：合并工具定义（按 function.name 去重、base 优先）同样取自 shared 单一实现。
    const { mergeToolDefs } = await intentMcp.loadMcpToolDefs();
    const dynamicMcpTools = await intentPrewarmToolDefs(payload);
    // T3-7：引擎可序列化参数与回调群抽为共享对象——in-process 与子进程两条路径同源，
    // 杜绝「改一处漏一处」的路径漂移（子进程路径经 RPC 传 params，回调在主进程侧执行）。
    const engineParams = {
      messages: payload.messages,
      model: payload.model,
      // 渲染层本已重建的 mcpTools 在前，意图预热补入的在后；按 function.name 去重（base 优先）。
      mcpTools: mergeToolDefs(payload.mcpTools || [], dynamicMcpTools),
      enabledSkills: payload.enabledSkills || [],
      skills: payload.skills || [],
      // P1-6 / P1-11：渲染层已下发，但此前被本白名单整体丢弃 → 主进程真机路径两项都不生效
      // （单测直接调 runAgent 全绿、真机全废）。缺省一律 undefined，让引擎走自己的默认/回落。
      skillDisclosure: payload.skillDisclosure || undefined,
      modelOverrides: payload.modelOverrides || undefined,
      cwd: payload.cwd,
      agentsMd: payload.agentsMd,
      memories: payload.memories || [],
      sandboxPolicy: payload.sandboxPolicy,
      approvalMode: payload.approvalMode || 'on-request',
      // T4-3：角色模板透传（渲染层经 ecosystem:employeeRuntime 取回）——
      // systemPrompt/toolNames 进引擎；审批档/沙箱在此取「角色与用户设置更严格者」后覆盖
      rolePreset: payload.rolePreset || undefined,
      planMode: !!payload.planMode,
      conversationId: payload.conversationId,
      tokenBudget: payload.tokenBudget || 0,
      // Phase 3-1：断点恢复上下文（渲染层「继续」时从 checkpointStore 取回注入）
      resumeContext: payload.resumeContext || '',
      // 2026-10-19：任务收尾描述粒度——渲染层设置经 payload 下发，白名单必须放行，
      // 否则「单测直接调 runAgent 全绿、真机全废」（本文件历史教训，见上方注释）。
      responseStyle: payload.responseStyle || undefined,
      // G-CUA：桌面自动化 opt-in——仅 macOS 且用户已在设置中开启「界面自动化」时，
      // 引擎才会把 computer_use 放进 tools 数组（V02 白名单守卫兜底）。此前本白名单
      // 会整体丢弃未登记参数 ⇒ 单测直调 runAgent 全绿、真机全废，故必须显式放行。
      computerUseEnabled: process.platform === 'darwin' && approvalSettings.getComputerUseEnabled(),
    };
    if (payload.rolePreset) {
      engineParams.approvalMode = stricterApproval(engineParams.approvalMode, payload.rolePreset.approvalMode);
      engineParams.sandboxPolicy = stricterSandbox(engineParams.sandboxPolicy, payload.rolePreset.sandboxPolicy);
      // T4-3 技能接线：数字员工 starter_skills → 本地 SKILL.md 内容（按名装载）注入引擎；
      // 内容安全处置统一在引擎侧不可信内容管道（guardUntrusted），此处只按名装载
      if (Array.isArray(payload.rolePreset.skillNames) && payload.rolePreset.skillNames.length
          && typeof deps.loadSkillContents === 'function') {
        const employeeSkills = deps.loadSkillContents(payload.rolePreset.skillNames);
        engineParams.skills = [...engineParams.skills, ...employeeSkills];
      }
    }
    try {
      const rawHandlers = deps.createToolHandlers({
        sender, signal: controller.signal, runId,
        // T1-3：orchestrate_task 的子任务事件上报通道（主进程 taskStore 状态 diff → 渲染层）
        emitSubagent: (evt) => emit('subagent', evt),
        // V01：宿主治理值显式下发（引擎参数已按「角色只收紧」钳制）——
        // 工具处理器内的审批档等治理值以此为准，不读模型参数
        approvalMode: engineParams.approvalMode,
        sandboxPolicy: engineParams.sandboxPolicy,
        cwd: payload.cwd,
        // R6：发起会话 id——对话内 orchestrate_task 建组时绑定会话（组按会话归属显示）
        conversationId: payload.conversationId || '',
        // R2（2026-10-20）：项目路径——orchestrate_task 建组时落 task_groups.project_path，
        // 使 Worker 记忆召回与归档用同一空间键（项目路径），而非子任务 worktree 的临时目录。
        projectPath: payload.projectPath || '',
        // G-CUA：当前会话模型（引擎侧嵌套形）——computer_use handler 据此解析凭证调 CUA 循环
        model: payload.model,
      });
      // P1-5：用户自定义生命周期 hooks 包在**真实 handler 之外、ALS 之内**——
      // 顺序有意如此：hook 里的 spawn/审批仍落在 runId 的取消域（abort 时一并收敛），
      // 而 pre 钩子拦截发生在真实工具执行之前（拦截时 handler 根本不会被调用）。
      const handlers = deps.toolHooks
        ? deps.toolHooks.wrap(rawHandlers, { cwd: payload.cwd, conversationId: payload.conversationId || '' })
        : rawHandlers;
      // N5 rootExecution 统一取消：全部 handler 在 { runId } 的 AsyncLocalStorage 上下文内执行——
      // 主进程 requestApproval 据此把挂起审批挂到 runId（abortRun → cancelApprovalsForRun 撤下）；
      // exec 子进程据此注册到 runId（abortRun → killChildrenForRun 终止）。
      // ALS 经 async 链自动传播，handler 内部 await 之后仍可取到 runId。
      for (const key of Object.keys(handlers)) {
        if (typeof handlers[key] === 'function') {
          const fn = handlers[key];
          handlers[key] = (...a) => deps.runScope.run({ runId }, () => fn(...a));
        }
      }
      // P2-8 / V-L1（J2）：收尾的异步部分（L1 对账 → 落库 → emit done）。
      // 为什么单独抽出来：引擎的 onDone 是**同步回调契约**（不 await、不看返回值），
      // 把 async 函数直接挂在 onDone 上会让 Promise 逃逸——一旦将来有人在里面抛错，
      // Node 15+ 会把未捕获 rejection 变成进程终止（主进程崩 = 用户所有会话一起丢）。
      // 因此回调保持同步、异步体显式 .catch，语义与事件顺序都不变。
      // 是否已把 done 事件发出去。仅用于下面 .catch 的兜底：finishRun 若在 emit('done')
      // **之前**抛错，doneSent 已是 true（兜底分支不会再补发），渲染层就会收不到任何终止
      // 事件、UI 永久停在 running。当前 finishRun 每步都有 try/catch，实际不可达，
      // 但这条不变量不该只靠"没人改动"来维持（P3：第二轮审查）。
      let doneEmitted = false;
      const finishRun = async (ft, usage, aborted) => {
        console.warn(`[agentRun] 完成 runId=${runId} 耗时=${Math.round((Date.now() - startedAt) / 1000)}s aborted=${!!aborted} usage=${usage ? `in=${usage.prompt_tokens}/out=${usage.completion_tokens}` : 'null'} textLen=${(ft || '').length}`);
        let outText = ft;
        let vVerdict = null; // P0-1：L1 判定结果（BLOCK = 自述与执行记录对不上，结论不可信，不沉淀）
        try {
          const vr = await vrun.finish(ft);
          if (typeof vr?.finalText === 'string') outText = vr.finalText;
          vVerdict = vr?.verdict || null;
          if (vr?.verdict === 'BLOCK') {
            console.warn(`[agentRun] V-L1 自述与执行记录对不上 runId=${runId} rule=${vr.ruleId || '?'} annotated=${!!vr.annotated}（只做标注，不续跑）`);
          }
        } catch (e) {
          console.warn(`[agentRun] V 层判定异常（不影响结果） runId=${runId}:`, e.message);
        }
        // ── P0-1（记忆写入闭环）：运行收尾归档 ──
        // 把「任务 + 结论」沉淀为该项目的 session 域记忆，供后续会话召回（跨会话学习闭环的入口）。
        // 收纳判据（宁缺毋滥，避免把闲聊/失败产物塞进记忆）：未中止 + 本轮确有工具执行 + 结论非空
        // + L1 未判 BLOCK。会话域是瞬时域：受半衰期衰减与容量总闸管理，不会无限膨胀。
        const conclusion = String(outText || '').trim();
        if (!aborted && toolCallCount > 0 && conclusion && vVerdict !== 'BLOCK') {
          archiveMemory({
            domain: 'session', importance: 0.6, entityTags: ['run_conclusion'], source: 'model_conclusion',
            content: `【任务】${lastUserText(payload.messages) || '(未记录)'}\n【结论】${conclusion.slice(0, 1200)}`,
            summary: conclusion.slice(0, 300),
          });
        }
        // 最终 assistant 消息主进程落库（唯一落库点；渲染层凭 mainPersisted 标记去重）
        const accepted = persistChatMessage({
          ...toStoreShape({ role: 'assistant', content: outText || '' }),
          modelName: payload?.model?.model?.model_id || '',
          tokensInput: usage?.prompt_tokens || 0,
          tokensOutput: usage?.completion_tokens || 0,
        });
        // V08：只有 durable 刷盘成功才宣称 mainPersisted:true；
        // 失败/未落库时如实上报（渲染层据此本地补显 + 提示保存状态），绝不假成功
        const dur = confirmDurable(accepted);
        emit('done', { finalText: outText, usage, aborted, mainPersisted: dur.persisted, persistState: dur.state });
        doneEmitted = true;
      };
      const cb = {
        // 中间轮（assistant+tool_calls / tool 结果）主进程直接落库，再照常推事件
        onMessage: (m) => {
          persistChatMessage(toStoreShape(m));
          emit('message', m);
        },
        onStream: (s) => emit('stream', s),
        onToolCall: (tc) => {
          vrun.onToolCall(tc); // N5：旁路缓存最近一次测试命令输出（不改引擎）
          toolCallCount += 1;  // P0-1：本轮确有工具执行 → 允许收尾归档结论
          emit('tool_call', tc);
        },
        // T1-3：子代理事件（spawn_subagent 生命周期）→ 渲染层子任务可视化
        onSubagentEvent: (evt) => emit('subagent', evt),
        // P0-B：任务清单 → 渲染层实时展示（让长任务进度对用户可见）
        onTodos: (info) => emit('todos', info),
        // Phase 3-1：token 预算熔断 → 保存断点（threadKey = conversationId）+ 通知渲染层
        // kind 必须落盘：恢复文案要按「预算触顶 / 模型超时」分流，不透传会让超时被说成预算触顶
        // （用户会去调大 token 预算，改错方向）。默认 'tokens' 保持既有行为不变。
        onSuspend: (info) => {
          let saved = false;
          try {
            const cp = require('./checkpointStore');
            saved = cp.saveCheckpoint(String(payload.conversationId || 'local'), {
              kind: info?.kind || 'tokens',
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
        // T0-5：结构化运行 trace 落本机 JSONL（userData/traces/<runId>.jsonl）。
        // 写失败由 runTrace 内部告警兜底，绝不影响运行；run_end 后顺带做文件级 LRU 淘汰。
        onTrace: (evt) => {
          if (!evt) return;
          // P2-8 / V-L1（N1/N2）：收下引擎出的执行事实快照（in-process 直传，子进程宿主
          // 经 engineProcess/registry.js 的 NOTIFY_CBS（onTrace 已在内）桥接，零额外接线）
          // P3：子代理事件带 `sub:true` —— 只记录、**不参与本 run 的台账与终态判据**。
          // 否则子代理的 verify_ledger 会让台账多一条、run_end 会让「最后一条即终态」
          // 的判据被子代理收尾覆盖。
          if (evt.type === 'verify_ledger' && !evt.sub) vrun.onLedger(evt);
          // P0-2：压缩摘要归档——引擎只发事件（trace 通道），落记忆库是宿主副作用。
          // 只归档主 run（!sub）：子代理压缩与 verify_ledger 同口径，不参与本 run 的沉淀。
          // 三层记忆 M0：压缩摘要属「跨会话的反思沉淀」→ domain=reflection + scope=project
          //   （此前落 session 域，只能被本会话召回且 re_hit 无法晋升，等于写进死结；改为项目级可跨会话复用）。
          if (evt.type === 'memory_saved' && !evt.sub && String(evt.summary || '').trim()) {
            archiveMemory({
              domain: 'reflection', scope: 'project', importance: 0.7,
              entityTags: ['compression_summary'], source: 'compressor',
              content: String(evt.summary),
              summary: String(evt.summary).slice(0, 300),
            });
          }
          runTrace.appendTraceEvent(runId, evt);
          if (evt.type === 'run_end' && !evt.sub) runTrace.evictOldTraces();
        },
        // P2-8 / V-L1（J2）：收尾时先做 L1 对账，再落库/推送。
        // ⚠️ 契约：回调**本身是同步函数**（引擎 `onDone?.(...)` 既不 await 也不看返回值），
        // 异步工作交给内部 finishRun 并显式 `.catch`——**绝不让 Promise 逃逸**：
        // Node 15+ 的未捕获 rejection 会直接终止主进程（整个会话一起丢）。
        // doneSent 在同步段置真，因此下方「引擎未触发 onDone」的兜底分支不会重复发 done。
        // 顺序很关键：BLOCK 时 finalText 末尾会多一段对账提示，用户看到的与落库的必须是同一份
        // 文本——否则重进会话提示就消失了（「只在屏幕上有」的假观测）。
        onDone: (ft, usage, aborted) => {
          doneSent = true;
          finishRun(ft, usage, aborted).catch((e) => {
            console.warn(`[agentRun] 收尾流程异常（已产出的结果仍会随下方兜底/前序事件送达） runId=${runId}:`, e?.message || e);
            // 兜底：finishRun 在 emit('done') 之前失败时，渲染层收不到任何终止事件
            // （doneSent 已置真 → 下方"引擎未触发 onDone"的兜底分支不会再补发 done）。
            // 补一条 error，至少让 UI 结束 running 态，而不是永久转圈。
            if (!doneEmitted) {
              try { emit('error', `收尾流程异常：${e?.message || String(e)}`); } catch { /* emit 失败无处可报 */ }
            }
          });
        },
      };
      // T3-7：双路径执行——engineHost 可用则引擎跑独立子进程（崩溃半径/内存硬上限隔离），
      // 否则主进程 in-process（agentRunner 单测通道 + utilityProcess 不可用时的生产降级链）。
      let finalText;
      if (deps.engineHost && typeof deps.engineHost.isAvailable === 'function' && deps.engineHost.isAvailable()) {
        console.warn(`[agentRun] 引擎子进程驻留 runId=${runId}`);
        finalText = await deps.engineHost.runEngine(runId, engineParams, {
          toolHandlers: handlers,
          // 通知型回调桥接：子进程引擎的 cb(...args) → 主进程侧同名回调（落库/emit/trace 就地执行）
          onEvent: (name, args) => {
            const f = cb[name];
            if (typeof f === 'function') f(...(args || []));
          },
          // 请求-响应回调：断点落盘仍是主进程副作用（子进程侧返回值退化为恒真，见 childEntry 注释）
          onSuspend: (info) => cb.onSuspend(info),
        });
      } else {
        const core = await deps.loadAgentCore();
        finalText = await core.runAgent({
          ...engineParams,
          signal: controller.signal,
          toolHandlers: handlers,
          ...cb,
        });
      }
      // 兜底：引擎部分退出路径若未触发 onDone（防御性），保证渲染层一定能收到终止事件
      if (typeof finalText === 'string' && !doneSent) {
        console.warn(`[agentRun] 兜底收尾 runId=${runId}（引擎未触发 onDone）：textLen=${(finalText || '').length} aborted=${controller.signal.aborted}`);
        const accepted = persistChatMessage({
          ...toStoreShape({ role: 'assistant', content: finalText || '' }),
          modelName: payload?.model?.model?.model_id || '',
        });
        const dur = confirmDurable(accepted);
        emit('done', { finalText, usage: null, aborted: controller.signal.aborted, mainPersisted: dur.persisted, persistState: dur.state });
      }
    } catch (err) {
      console.error(`[agentRun] 异常终止 runId=${runId} 耗时=${Math.round((Date.now() - startedAt) / 1000)}s：${String(err?.message || err).slice(0, 400)}`);
      // T3-7 验收①：引擎子进程崩溃/被杀——主进程与 UI 存活；落断点并明示可「继续」续跑。
      // 断点 kind 区分预算熔断：渲染层注入的 resumeContext 文案按中断原因分支（见 useAgentRun.ts）
      if (err && err.engineExited) {
        try {
          const cp = require('./checkpointStore');
          cp.saveCheckpoint(String(payload.conversationId || 'local'), {
            kind: 'engine-exit',
            summary: '',
            usage: null,
            rounds: 0,
            rescues: 0,
            budget: 0,
            model: payload?.model?.model?.model_id || '',
            cwd: payload?.cwd || '',
          });
        } catch (e) { console.warn('[agentRunner] 引擎退出断点保存失败:', e.message); }
        emit('error', '引擎进程已退出，本次运行中断（主进程与界面不受影响）；可发送「继续」从断点续跑。');
      } else {
        emit('error', String(err?.message || err));
      }
    } finally {
      runs.delete(runId);
      runApprovalModes.delete(runId);
      // T3-1：运行结束即释放该 run 的全部大载荷临时文件（用后即清）
      try { bigPayload.releaseRun(runId); } catch (e) { console.warn('[agentRunner] 大载荷清理失败:', e.message); }
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
  // T3-7：子进程路径联动转发 abort（子进程侧 AbortController 级联引擎循环）
  try { deps?.engineHost?.abortEngine?.(runId); } catch (e) { console.warn('[agentRunner] abort 转发失败:', e.message); }
  // N5 rootExecution 统一取消：撤下该 run 的挂起审批 + 终止其 shell 子进程
  try { deps?.cancelApprovalsForRun?.(runId); } catch (e) { console.warn('[agentRunner] 撤审批失败:', e.message); }
  try { deps?.killChildrenForRun?.(runId); } catch (e) { console.warn('[agentRunner] 子进程终止失败:', e.message); }
  return true;
}

// 中止全部运行（model:abort 停止按钮联动）
function abortAllRuns() {
  const n = runs.size;
  for (const [runId, r] of runs) {
    r.controller.abort();
    try { deps?.engineHost?.abortEngine?.(runId); } catch { /* 单条转发失败不阻断其余中止 */ }
    try { deps?.cancelApprovalsForRun?.(runId); } catch { /* 单条撤审批失败不阻断 */ }
    try { deps?.killChildrenForRun?.(runId); } catch { /* 单条子进程终止失败不阻断 */ }
  }
  return n;
}

// Phase 3-4：仪表盘数据源（main.js IPC 'agent:token/state' 直接透传）
function getTokenState() {
  return lastBudgetState;
}

// T2-5：崩溃聚合关联用——当前在役运行的 runId 列表（异常记录附带活跃 run，诊断可回查 trace）
function getActiveRunIds() {
  return [...runs.keys()];
}

module.exports = {
  initAgentRunner, startAgentRun, abortRun, abortAllRuns,
  getTokenState, getActiveRunIds, agentRunnerReady,
  // 2026-10-16：重导出纪律函数与当前审批档 getter。
  // 实际实现已抽到 approvalPolicy.js（唯一事实源），此处重导出只为兼容既有引用方。
  stricterApproval, stricterSandbox,
  // 仅表示「最近一次 startAgentRun 写入的档」，供状态回看；**不得**用于无人值守路径（P1-1）。
  getCurrentApprovalMode: () => currentUserApprovalMode,
  // 无人值守/编排快照用：取「发起该 run 时用户选的档」，run 结束后返回 null（调用方回落设置）
  getApprovalModeFor: (runId) => runApprovalModes.get(runId) || null,
  startAgentRunWhenReady,
};

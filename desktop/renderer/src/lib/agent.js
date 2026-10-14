// Agent 引擎接入层（P0-4 重构）：
// 优先走【主进程运行模式】：runAgent 循环在主进程执行（ipc agent:run + agent:event 事件流），
// 渲染层只做发起/订阅/中止——刷新窗口不再杀死进行中任务，UI 与调度解耦。
// 当主进程通道不可用（旧版 preload / 纯 Node 测试环境）时回退【进程内模式】：
// 引擎在当前上下文直接运行，工具通道经 window.mjcode.* 注入（原行为，agent-engine.test.mjs 依赖）。
// 真实引擎在 agent-core 包（headless 复用）。
import { runAgent as coreRunAgent, BASE_TOOLS, BUILTIN_SKILL_IDS, decomposeTask, looksLargeTask, parsePlanResponse } from '../../../agent-core/index.js';

export { BASE_TOOLS, BUILTIN_SKILL_IDS, decomposeTask, looksLargeTask, parsePlanResponse };

// P0-5：前台会话默认 token 预算（成本闸）。此前渲染层从不传 tokenBudget（引擎默认 0=不限），
// 前台消耗仅靠 120 轮硬顶兜底，单会话成本不可控。预算超限时引擎会先自动压缩上下文续跑
// （最多 3 次救援，见 agent-core runAgent 的 P1-I 预算闸），仍超限才优雅收尾，不会硬切断对话。
// 真机复盘：200k 对文件密集型审查任务太紧（每轮重复读取上下文，窗口很快打满，
// 用户两次看到 470k 熔断文案）→ 放宽到 600k；配合 3 次救援，单任务累计上限 ≈ 2.4M。
// 分层预算（复盘文档 P1-1 采纳）：looksLargeTask 命中的大任务（审查/批量/重构类，零成本
// 本地启发式）自动升档到 LARGE_TASK_TOKEN_BUDGET——大任务拆子块的滚动压缩属 Phase 3，
// 当前以「更大单窗口 + 多次救援」过渡；调用方显式传入 tokenBudget（含 0=关闭）始终优先。
export const FRONTEND_TOKEN_BUDGET = 600000;
export const LARGE_TASK_TOKEN_BUDGET = 1000000;

// 从 options.messages 取最后一条 user 消息文本（分层预算的档位判定输入）
function lastUserText(options) {
  const msgs = options?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m?.role === 'user') return typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
  }
  return '';
}

// 预算档位解析：显式传入 > 大任务档 > 常规档（显式 0=关闭也优先尊重）
function resolveTokenBudget(options) {
  if (options?.tokenBudget !== undefined) return options.tokenBudget;
  return looksLargeTask(lastUserText(options)) ? LARGE_TASK_TOKEN_BUDGET : FRONTEND_TOKEN_BUDGET;
}

let runSeq = 0;

// 主进程模式：把 runAgent 语义映射为「发起 + 事件订阅 + 中止」，对外保持原签名不变
// （ChatArea 零改动：onMessage/onStream/onToolCall/onDone 回调与 AbortSignal 语义完全一致）
function runAgentViaMain(options) {
  const { signal, onMessage, onStream, onToolCall, onDone, ...rest } = options;
  return new Promise((resolve, reject) => {
    const mj = globalThis.window?.mjcode;
    if (!mj?.agentRun || !mj?.onAgentEvent) {
      reject(new Error('主进程 Agent 通道不可用'));
      return;
    }
    runSeq += 1;
    const runId = `run-${Date.now().toString(36)}-${runSeq}`;
    let settled = false;
    let off = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (typeof off === 'function') off();
      fn?.(arg);
    };
    off = mj.onAgentEvent((evt) => {
      if (!evt || evt.runId !== runId) return;
      try {
        switch (evt.type) {
          case 'message': onMessage?.(evt.data); break;
          case 'stream': onStream?.(evt.data); break; // 引擎轮次边界信号（清空上一轮流式文本）
          case 'tool_call': onToolCall?.(evt.data); break;
          case 'done':
            finish(null);
            onDone?.(evt.data.finalText, evt.data.usage, evt.data.aborted);
            resolve(evt.data.finalText);
            break;
          case 'error':
            finish(reject, new Error(String(evt.data)));
            break;
          default: break; // delta/reasoning 流经 model:delta 独立通道直达窗口，不经此分发
        }
      } catch (e) {
        console.warn('[agent] 事件回调异常:', e);
      }
    });
    if (signal) {
      // 中止即时收尾（Bugfix：此前 UI 要等主进程引擎跑完当前轮才收到真实 done 事件，
      // 点击「停止」后最长可等数十秒无反馈，「已停止」要刷新才出现）。
      // 信号一触发就本地 settle：立即回调 onDone(aborted=true) 让 UI 即时收敛；
      // 主进程侧照常 agentAbort 异步中止清理，迟到的真实 done 事件被 settled 幂等忽略。
      const onAbort = () => {
        mj.agentAbort(runId);
        const wasSettled = settled;
        finish(null);
        if (!wasSettled) {
          onDone?.('', null, true);
          resolve('');
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    mj.agentRun({ ...rest, tokenBudget: resolveTokenBudget(options), runId })
      .then((res) => {
        if (!res?.ok) finish(reject, new Error(res?.error || 'Agent 运行启动失败'));
      })
      .catch((e) => finish(reject, e instanceof Error ? e : new Error(String(e))));
  });
}

// 进程内模式（回退/测试）：引擎在当前上下文运行，工具通道经 window.mjcode.* 组装注入
function runAgentInProcess(options) {
  const mj = () => globalThis.window?.mjcode;
  const requireChannel = (name) => (...args) => {
    const api = mj();
    if (!api || typeof api[name] !== 'function') throw new Error(`工具通道不可用: ${name}`);
    return api[name](...args);
  };
  const toolHandlers = {
    chat: requireChannel('chat'),
    shell: requireChannel('shell'),
    readFile: requireChannel('readFile'),
    writeFile: requireChannel('writeFile'),
    editFile: requireChannel('editFile'),
    applyPatch: requireChannel('applyPatch'),
    listDir: requireChannel('listDir'),
    grep: requireChannel('grep'),
    glob: requireChannel('glob'),
    gitStatus: requireChannel('gitStatus'),
    gitDiff: requireChannel('gitDiff'),
    gitLog: requireChannel('gitLog'),
    gitCommit: requireChannel('gitCommit'),
    gitAdd: (...args) => {
      const api = mj();
      if (api && typeof api.gitAdd === 'function') return api.gitAdd(...args);
      return { stdout: '', stderr: '', exitCode: 0, error: '当前版本不支持 gitAdd 通道' };
    },
    mcpCallTool: requireChannel('mcpCallTool'),
  };
  // P0-5：默认注入前台 token 预算（分层：大任务自动升档）；options.tokenBudget 显式传值（含 0）时以调用方为准
  return coreRunAgent({ ...options, tokenBudget: resolveTokenBudget(options), toolHandlers });
}

export function runAgent(options = {}) {
  const mj = globalThis.window?.mjcode;
  const mainChannelReady = !!(mj?.agentRun && mj?.onAgentEvent && mj?.agentAbort);
  return mainChannelReady ? runAgentViaMain(options) : runAgentInProcess(options);
}

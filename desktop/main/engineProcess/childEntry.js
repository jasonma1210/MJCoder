// T3-7：引擎子进程入口——加载 agent-core 跑 runAgent，工具与请求-响应回调全部 RPC 回主进程。
// 本文件是 CJS（utilityProcess.fork 与 child_process.fork 均可直接执行）；
// agent-core 是 ESM，经动态 import 加载（Node 12+ CJS→ESM 互操作，真机 fork 子进程已验证路径）。
//
// 依赖方向反转（本里程碑核心）：
//   工具实现（chat/shell/审批/MCP 等 50 通道，见 registry.js 的 TOOL_CHANNELS）全部留在主进程——模型凭证、审批卡、窗口推送不出主进程；
//   子进程只跑引擎循环，toolHandlers 是本文件生成的 RPC 代理，调用即 {t:'toolReq'} 回主进程执行。
//   取证依据：agent-core resolveChannel 返回 (args) => toolHandlers[name](args)，丢弃第二参 ctx，
//   signal 由主进程 handler 闭包各自供给——因此 RPC 边界只需序列化 args 一个参数。
const path = require('path');
const { pathToFileURL } = require('url');
const { attachChildSide } = require('./transport');
const { TOOL_CHANNELS, NOTIFY_CBS } = require('./registry');

const transport = attachChildSide();
const ENGINE_ENTRY = pathToFileURL(path.join(__dirname, '..', '..', 'agent-core', 'index.js')).href;

let enginePromise = null;
function ensureEngine() {
  if (!enginePromise) {
    enginePromise = import(ENGINE_ENTRY).catch((err) => {
      enginePromise = null; // 失败可重试（与主进程 loadAgentCore 同纪律）
      throw new Error(`引擎加载失败（子进程动态 import）：${err?.message || err}`);
    });
  }
  return enginePromise;
}

let callSeq = 0;
const pendingTool = new Map(); // callId -> {resolve, reject}
const pendingCb = new Map();   // callId -> {resolve}
const controllers = new Map(); // runId -> AbortController（主进程 {t:'abort'} 级联）

// ── A-09：进程 RSS 看门狗 ──
// `--max-old-space-size` 只管 V8 堆，管不住 ArrayBuffer / WASM / 原生模块的堆外内存。
// 失控任务若持续分配堆外内存，宿主只能等系统 OOM（整机受影响）。这里由子进程自监控：
// 超过 RSS_LIMIT_MB 主动以 137 退出，宿主走既有的 engineExited 分支（保存断点 + 可续跑）。
// 环境变量 MJCODE_ENGINE_RSS_LIMIT_MB 可调；0 表示关闭看门狗（排障用）。
const RSS_LIMIT_MB = Math.max(0, Number(process.env.MJCODE_ENGINE_RSS_LIMIT_MB || 3072) || 0);
const RSS_CHECK_INTERVAL_MS = 5000;
if (RSS_LIMIT_MB > 0 && typeof setInterval === 'function') {
  const rssTimer = setInterval(() => {
    try {
      const rssMb = process.memoryUsage().rss / (1024 * 1024);
      if (rssMb > RSS_LIMIT_MB) {
        console.error(`[engineChild] RSS ${Math.round(rssMb)}MB 超过上限 ${RSS_LIMIT_MB}MB，主动退出（保留断点续跑）`);
        process.exit(137);
      }
    } catch { /* 监控失败不影响主流程 */ }
  }, RSS_CHECK_INTERVAL_MS);
  if (typeof rssTimer.unref === 'function') rssTimer.unref();
}

// 工具通道代理：引擎调用 → RPC 主进程实现 → 等回执
function makeToolHandlers() {
  const h = {};
  for (const name of TOOL_CHANNELS) {
    h[name] = (args) => new Promise((resolve, reject) => {
      const callId = `t${++callSeq}`;
      pendingTool.set(callId, { resolve, reject });
      transport.send({ t: 'toolReq', callId, name, args: args === undefined ? null : args });
    });
  }
  return h;
}
const toolHandlers = makeToolHandlers();

// 通知型回调全部转 {t:'evt'} 转发（实参收进 args 数组——onDone 是多参回调 (ft, usage, aborted)）；
// 请求-响应型（onSuspend）等主进程回值，引擎据返回值决定收尾文案（断点是否已保存）。
function makeCallbacks(runId) {
  const cbs = {};
  for (const name of NOTIFY_CBS) {
    cbs[name] = (...args) => transport.send({ t: 'evt', id: runId, cb: name, args });
  }
  // A-05 收口（2026-10-21）：引擎侧已改为 `await onSuspend(...)`，这里必须给出**可靠的回执**。
  //   · 主进程正常回执 {t:'cbRes', result:boolean} → 用真实落盘结果；
  //   · 主进程已收尾 / 回执丢失 → 超时后按 false 返回（fail-closed 文案：不说「已保存」）；
  //   · 超时兜底是为了避免 await 永远挂起（旧实现返回 Promise 恒真，不挂起但会说谎）。
  const SUSPEND_ACK_TIMEOUT_MS = 5000;
  cbs.onSuspend = (info) => new Promise((resolve) => {
    const callId = `c${++callSeq}`;
    let timer = null;
    const done = (v) => {
      if (timer) { clearTimeout(timer); timer = null; }
      pendingCb.delete(callId);
      resolve(v === true);
    };
    pendingCb.set(callId, { resolve: done });
    timer = setTimeout(() => {
      console.warn('[engineChild] onSuspend 回执超时，按「未保存」收尾（避免 await 永久挂起）');
      done(false);
    }, SUSPEND_ACK_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    transport.send({ t: 'cbReq', id: runId, callId, cb: 'onSuspend', args: [info] });
  });
  return cbs;
}

transport.onMessage(async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'run': {
      const { id, params } = msg;
      const controller = new AbortController();
      controllers.set(id, controller);
      try {
        const core = await ensureEngine();
        const finalText = await core.runAgent({
          ...params,
          signal: controller.signal,
          toolHandlers,
          ...makeCallbacks(id),
        });
        transport.send({ t: 'runDone', id, finalText: typeof finalText === 'string' ? finalText : String(finalText ?? '') });
      } catch (err) {
        // 中止竞态：主进程 abort 使在途 chat fetch 抛错——引擎未走到优雅收尾时，
        // 本地 signal 已置位则按「优雅中止」上报 runDone（上层据 controller.aborted 发 done 事件，
        // 与 in-process 路径的 aborted 语义对齐，不产生 error 噪声）
        if (controller.signal.aborted) {
          transport.send({ t: 'runDone', id, finalText: '' });
        } else {
          transport.send({ t: 'runError', id, message: String(err?.message || err) });
        }
      } finally {
        controllers.delete(id);
      }
      break;
    }
    case 'abort': {
      const c = controllers.get(msg.id);
      if (c) c.abort();
      break;
    }
    case 'toolRes': {
      const p = pendingTool.get(msg.callId);
      if (!p) break;
      pendingTool.delete(msg.callId);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || '工具调用失败'));
      break;
    }
    case 'cbRes': {
      const p = pendingCb.get(msg.callId);
      if (!p) break;
      pendingCb.delete(msg.callId);
      p.resolve(msg.result);
      break;
    }
    default: break;
  }
});

// 握手：加载器就绪即通知宿主（宿主收到后才发 run，避免消息早于监听）
transport.send({ t: 'ready' });

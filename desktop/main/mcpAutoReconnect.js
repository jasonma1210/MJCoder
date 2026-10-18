// ═══════════════════════════════════════════════════════════════
// P1-3：MCP 服务进程崩溃后的自动重连（指数退避 + 上限 + 幂等 + 可取消）
// ═══════════════════════════════════════════════════════════════
// 背景：mcpClient.js:700-714 在**运行期**子进程退出时只上报一次 onStatus(name,'crashed',code)，
// 此后该服务永久失效——只能由用户去 UI 上手动点「重连」。无人值守通道（Worker / 定时任务）
// 里没有人在看 UI，一次 OOM / 网络抖动就足以让整轮会话的 MCP 工具全部失效且无人知晓。
//
// 职责边界：本模块**只**决定「什么时候重试、重试几次、怎么退避」，
// 不碰任何连接细节——reconnect(name) 由宿主注入（主进程 mcp.js 的 reconnectSaved），
// 状态回执 emitStatus 也由宿主注入（emitMcpStatus）。因此可脱离 Electron 直接单测。
//
// 关键不变量（这三条是「不做成无限重连风暴」的全部依据）：
//   ① 幂等：同一服务的重试链**一旦在途就只保留一条**。重复收到 crashed（例如同一进程被多次
//      上报、或其它路径再次触发）不会叠出多条链 → 不会出现 N 倍重连。
//   ② 无反馈回路：本模块的 emitStatus **直连渲染层事件**（emitMcpStatus），绝不经 onStatus。
//      否则「重连失败 → 发 crashed → 再次触发排程」会变成死循环；耗尽次数时同样只 emitStatus。
//   ③ 任何非 crashed 状态（connected / 人工断开 / 用户手动重连成功）都取消该服务的在途链——
//      人工已经处理过的事，不该再被自动重连覆盖。

'use strict';

/**
 * 创建一个自动重连调度器。
 *
 * @param {object} opts
 * @param {(name:string)=>Promise<{ok:boolean,error?:string,toolCount?:number}>} opts.reconnect
 *        宿主注入的重连实现（返回 {ok,error}，不抛）。
 * @param {(name:string,status:string,code:number|null)=>void} opts.emitStatus
 *        状态回执（直连渲染层事件，不经 onStatus）。
 * @param {{setTimeout:Function,clearTimeout:Function}} [opts.timer]
 *        定时器注入点（默认全局；测试可注入假定时器）。
 * @param {number} [opts.maxAttempts=5]   单个服务最多重试次数（含首次）。
 * @param {number} [opts.baseDelayMs=2000] 首次退避基数（ms）。
 * @param {number} [opts.maxDelayMs=60000] 退避封顶（ms）。
 * @param {number} [opts.jitter=0.2]      抖动比例（0~1，避免多服务同刻重连造成惊群）。
 * @param {()=>number} [opts.rand=Math.random] 随机源（测试可注入定值）。
 * @param {(msg:string)=>void} [opts.log] 诊断日志。
 * @returns {{onStatus:Function,cancel:Function,cancelAll:Function,inspect:Function,pending:Function}}
 */
function createMcpAutoReconnect({
  reconnect,
  emitStatus,
  timer = { setTimeout, clearTimeout },
  maxAttempts = 5,
  baseDelayMs = 2000,
  maxDelayMs = 60000,
  jitter = 0.2,
  rand = Math.random,
  log = (msg) => console.warn('[mcp-reconnect]', msg),
} = {}) {
  // name -> { attempt, timerId, code, cancelled }
  const chains = new Map();

  const say = (msg) => { try { log(msg); } catch { /* 日志失败不影响调度 */ } };
  const safeEmit = (name, status, code) => {
    try { if (typeof emitStatus === 'function') emitStatus(name, status, code); } catch (e) {
      say(`emitStatus 失败（不影响调度）：${e && e.message}`);
    }
  };

  // 第 n 次退避：base * 2^(n-1)，封顶 maxDelayMs；再乘一个 [1-jitter,1] 的下行抖动。
  // 用下行抖动（只会变短、不会变长）而不是对称抖动：对称抖动可能把延迟顶到封顶之上，
  // 让「最多 N 次重试」的最坏总时长不可预测。
  const delayOf = (attempt) => {
    const raw = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
    if (!jitter) return Math.round(raw);
    const r = Math.min(1, Math.max(0, Number(rand()) || 0));
    return Math.max(0, Math.round(raw * (1 - jitter * r)));
  };

  const arm = (name, chain) => {
    chain.attempt += 1;
    if (chain.attempt > maxAttempts) {
      // 次数耗尽：如实上报仍然不可用（继续显示 crashed），并停止链条——绝不继续重试。
      chains.delete(name);
      say(`服务 ${name} 自动重连已达上限 ${maxAttempts} 次，放弃（可在 UI 手动重连）`);
      safeEmit(name, 'crashed', chain.code == null ? null : chain.code);
      return;
    }
    const delay = delayOf(chain.attempt);
    chain.timerId = timer.setTimeout(() => {
      chain.timerId = null;
      void runAttempt(name, chain);
    }, delay);
    // 不阻止进程退出（Electron 退出时不该被一个待重试的定时器拖住）
    try { if (chain.timerId && typeof chain.timerId.unref === 'function') chain.timerId.unref(); } catch { /* 无 unref 语义 */ }
  };

  const isStale = (name, chain) => chain.cancelled || chains.get(name) !== chain;

  const runAttempt = async (name, chain) => {
    if (isStale(name, chain)) return;
    let res;
    try {
      res = await reconnect(name);
    } catch (e) {
      // fail-open：重连实现自身抛错也算「本次失败」，继续退避，绝不冒泡打断调用方
      res = { ok: false, error: e && e.message ? e.message : String(e) };
    }
    if (isStale(name, chain)) return; // 期间被取消 / 被替换
    if (res && res.ok) {
      chains.delete(name);
      say(`服务 ${name} 已自动重连成功（第 ${chain.attempt} 次尝试）`);
      safeEmit(name, 'connected', null); // 非 crashed：渲染层据此撤下崩溃标记
      return;
    }
    say(`服务 ${name} 第 ${chain.attempt} 次自动重连失败：${(res && res.error) || 'unknown'}`);
    arm(name, chain);
  };

  /** crashed → 排程重连（幂等）；任何其它状态 → 取消该服务在途链 */
  const onStatus = (name, status, code) => {
    if (!name || typeof status !== 'string') return;
    if (status === 'crashed') {
      const existing = chains.get(name);
      if (existing) { existing.code = code == null ? existing.code : code; return; } // 幂等：不叠加
      const chain = { attempt: 0, timerId: null, code: code == null ? null : code, cancelled: false };
      chains.set(name, chain);
      say(`服务 ${name} 崩溃（code=${code == null ? 'null' : code}），启动自动重连（最多 ${maxAttempts} 次）`);
      arm(name, chain);
      return;
    }
    cancel(name);
  };

  /** 取消某服务的在途重试链（用户断开 / 手动重连成功 / 删除服务时调用） */
  function cancel(name) {
    const chain = chains.get(name);
    if (!chain) return false;
    chain.cancelled = true;
    if (chain.timerId != null) { try { timer.clearTimeout(chain.timerId); } catch { /* 已触发 */ } }
    chains.delete(name);
    return true;
  }

  function cancelAll() {
    for (const name of [...chains.keys()]) cancel(name);
  }

  const inspect = (name) => {
    const c = chains.get(name);
    return c ? { attempt: c.attempt, code: c.code, waiting: c.timerId != null } : null;
  };
  const pending = () => [...chains.keys()];

  return { onStatus, cancel, cancelAll, inspect, pending };
}

module.exports = { createMcpAutoReconnect };

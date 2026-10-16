// T3-7：双形态消息传输适配——同一套 RPC 协议跑在两种子进程宿主上。
//   Electron utilityProcess：父侧 child.postMessage / child.on('message')（消息可能包一层 {data}），
//                            子侧 process.parentPort.postMessage / parentPort.on('message', e => e.data)
//   Node child_process.fork：父侧 child.send / child.on('message')（消息即对象本体），
//                            子侧 process.send / process.on('message')
// 生产走 utilityProcess 获得进程隔离；测试注入 child_process.fork 用真实子进程跑全协议，
// 两种形态共享 registry.js 定义的语义，差异只在本适配层。
//
// unwrap 判别依据：协议消息顶层必有字符串 t；若宿主把消息包成 {data:{t:...}} 则还原。
// 协议自身字段（args/result/cb）不会与判别冲突——顶层 t 存在即原形。

// utilityProcess 形态下 'message' 事件的载荷形状兼容（不同 Electron 版本传 event 或裸消息）
function unwrapHostMessage(msg) {
  if (msg && typeof msg === 'object' && typeof msg.t !== 'string'
    && msg.data && typeof msg.data === 'object' && typeof msg.data.t === 'string') {
    return msg.data;
  }
  return msg;
}

// 宿主侧（主进程）：把 fork 返回的子进程对象包装为统一接口
function attachHost(child) {
  const isUtility = typeof child.postMessage === 'function';
  return {
    child,
    send: (m) => {
      try {
        if (isUtility) child.postMessage(m);
        else child.send(m);
      } catch (e) {
        // 进程已退出时的竞态发送：丢弃并留痕（上层靠 exit 语义收尾，不因此崩）
        console.warn('[engineTransport] 发送失败:', e.message);
      }
    },
    onMessage: (fn) => { child.on('message', (msg) => fn(unwrapHostMessage(msg))); },
    onExit: (fn) => { child.on('exit', fn); },
    onError: (fn) => { if (typeof child.on === 'function') child.on('error', fn); },
    kill: () => { try { child.kill(); } catch { /* 已退出 */ } },
  };
}

// 子进程侧：同样包装为统一接口（childEntry 使用）
function attachChildSide() {
  if (process.parentPort) {
    return {
      send: (m) => {
        try { process.parentPort.postMessage(m); }
        catch (e) { console.error('[engineChild] 发送失败:', e.message); }
      },
      onMessage: (fn) => process.parentPort.on('message', (e) => fn(e && e.data !== undefined ? e.data : e)),
    };
  }
  if (typeof process.send === 'function') {
    return {
      send: (m) => {
        try { process.send(m); }
        catch (e) { console.error('[engineChild] 发送失败:', e.message); }
      },
      onMessage: (fn) => { process.on('message', fn); },
    };
  }
  throw new Error('engineChild 需要 IPC 通道（process.parentPort 或 process.send）');
}

module.exports = { attachHost, attachChildSide, unwrapHostMessage };

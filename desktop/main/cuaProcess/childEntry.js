// T3-6：Computer Use 原生执行子进程入口——osascript/screencapture 不再在主进程执行。
// computerUse.js 是 CJS 纯 Node 模块（execFile 驱动，零 Electron 依赖），子进程直接 require；
// 传输复用 engineProcess/transport.js（utilityProcess 与 fork 双形态，协议语义一致）。
const { attachChildSide } = require('../engineProcess/transport');
const { CUA_CHANNELS } = require('./registry');
const cua = require('../computerUse');

// 通道实现表：签名与 computerUse.js 导出对齐（deps 注入面不跨进程，子进程用真实实现）
const IMPL = {
  isAccessibilityGranted: () => cua.isAccessibilityGranted(),
  collectAxTree: (appName) => cua.collectAxTree(appName),
  performAction: (action, node, deps) => cua.performAction(action, node, deps || {}),
  isScreenLocked: () => cua.isScreenLocked(),
};

if (CUA_CHANNELS.some((name) => typeof IMPL[name] !== 'function')) {
  throw new Error('cuaProcess/childEntry: 通道实现与 registry 不一致');
}

const transport = attachChildSide();

transport.onMessage(async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'shutdown') process.exit(0);
  if (msg.t !== 'call') return;
  const fn = IMPL[msg.name];
  if (!fn) {
    transport.send({ t: 'callRes', callId: msg.callId, ok: false, error: `未知通道：${msg.name}` });
    return;
  }
  try {
    const result = await fn(...(msg.args || []));
    transport.send({ t: 'callRes', callId: msg.callId, ok: true, result });
  } catch (err) {
    // 业务错误（权限拒绝/脚本失败/平台不支持）原样回传——宿主按「调用失败」处理，不触发重启
    transport.send({ t: 'callRes', callId: msg.callId, ok: false, error: String(err?.message || err) });
  }
});

transport.send({ t: 'ready' });

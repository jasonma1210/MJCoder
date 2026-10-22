// 团队 IPC 统一埋点（2026-10-21）
//
// 从 `ipc/teams.js` 抽出：该文件已贴 800 行软档，而「包装 ipcMain.handle」这段
// 与团队业务无关，属于纯观测基础设施，放这里更合适。
//
// 为什么用包装而不是在 20+ 个 handler 里逐处手写：
//   团队链路的问题经常是「某一环没走」，需要看到完整请求序列；逐处埋点必漏，
//   且新加 handler 会静默游离在观测之外。
// 包装只在本函数执行期间替换 `ipcMain.handle`，返回即还原，不影响其它 IPC 域。
// 读接口（500ms 轮询）做 2s 节流，避免把写操作的关键事件淹没在轮询里。
const teamDebug = require('./teamDebugLog');

const TRACE_READ_CHANNELS = new Set(['teams:list', 'teams:listThreadRuns', 'teams:listMessages']);
const READ_TRACE_THROTTLE_MS = 2000;

/** 响应摘要：只留「这条通道说明了什么」，不把整个返回体写进日志。 */
function summarizeIpcOut(channel, out) {
  if (!out || typeof out !== 'object') return { ok: null };
  const base = { ok: out.ok !== false, code: out.code || null, error: out.error || null };
  if (channel === 'teams:list' && Array.isArray(out.teams)) base.teams = out.teams.length;
  if (channel === 'teams:get' && out.team) {
    base.team = {
      id: out.team.id,
      name: out.team.name,
      members: Array.isArray(out.team.members) ? out.team.members.length : 0,
      leadMissing: !!out.team.leadMissing,
    };
  }
  if (channel === 'teams:dispatch') {
    base.dispatch = { groupId: out.groupId || null, tasks: out.tasks || 0 };
  }
  if (channel === 'teams:listThreadRuns' && Array.isArray(out.runs)) {
    base.runs = out.runs.length;
    // 只留最近 10 个 run 的骨架，避免一次拉取把日志撑大
    base.runDigest = out.runs.slice(-10).map((r) => ({
      runId: r?.runId || null,
      teamId: r?.teamId || null,
      status: r?.status || null,
      tasks: Array.isArray(r?.tasks) ? r.tasks.length : 0,
      progress: r?.progress || null,
    }));
  }
  return base;
}

/**
 * 安装团队 IPC 埋点：调用方在注册 handler 期间使用，`finally` 里调用返回值还原。
 * @param {object} ipcMain Electron ipcMain
 * @returns {() => void} 还原函数
 */
function installTeamsIpcTracing(ipcMain) {
  const readTraceAt = new Map();
  const realHandle = ipcMain.handle.bind(ipcMain);

  const traceIpc = (channel, fn) => async (evt, payload = {}) => {
    const t0 = Date.now();
    let skipped = false;
    if (TRACE_READ_CHANNELS.has(channel)) {
      const last = readTraceAt.get(channel) || 0;
      if (t0 - last < READ_TRACE_THROTTLE_MS) skipped = true;
      else readTraceAt.set(channel, t0);
    }
    if (!skipped) teamDebug.log('ipc', 'request', { channel, payload }, { level: 'verbose' });
    try {
      const out = await fn(evt, payload);
      if (!skipped) {
        teamDebug.log('ipc', 'response', { channel, ms: Date.now() - t0, ...summarizeIpcOut(channel, out) });
      }
      return out;
    } catch (e) {
      teamDebug.log('ipc', 'error', { channel, ms: Date.now() - t0, error: e });
      throw e;
    }
  };

  ipcMain.handle = (channel, fn) => realHandle(channel, traceIpc(channel, fn));
  return () => { ipcMain.handle = realHandle; };
}

module.exports = { installTeamsIpcTracing, summarizeIpcOut };

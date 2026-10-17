'use strict';
// C2（2026-10-17）：进程级崩溃的可观测性 + 自愈。
//
// 缺口：全仓没有 render-process-gone / child-process-gone / unresponsive 监听。
//   JS 层异常还有 window.onerror → diag:report 兜底（这次 IconFile 崩溃就是靠它拿到的），
//   但**渲染进程整体崩掉**（OOM、GPU 驱动、被系统杀掉）时渲染层自己报不了，主进程也没人听
//   → 用户看到白屏，我们手里零证据（Crashpad 也没有 dmp：见 2026-10-17 现场核查）。
//
// 设计（对齐 Electron 官方推荐；本地优先纪律：全部落本机、不上传）：
//   1) render-process-gone：记录 reason / exitCode / 活跃 runId / trace 尾部（由 diagnostics 自动附），
//      非 clean-exit 自动 reload 主窗口——会话数据在 local-data.json 里，reload 不丢历史。
//   2) 防「崩溃-重载」死循环：滑动窗口内超过阈值就停止自动 reload，只记录并留通知。
//      没有这道闸，一个必崩的渲染 bug 会变成无限重载（每轮都写日志，很快把 5MB 诊断文件刷满）。
//   3) child-process-gone：GPU / utility / network 子进程崩溃也要记——否则现场表现只是
//      「界面变慢 / 白块」，用户不会报，我们也永远不知道。
//   4) unresponsive / responsive：界面无响应**不自动重载**。重载等于把用户正在跑的任务杀掉，
//      这里只记录 + 留通知，由用户自己决定（T1 的思考计时就是为了减少这种误判）。
//
// 可测性：决策与副作用分离，依赖全部可注入（app / window / reportError / now）。

const DEFAULT_RELOAD_WINDOW_MS = 60 * 1000; // 1 分钟窗口
const DEFAULT_MAX_RELOADS = 3;              // 窗口内最多自动重载 3 次
const MAX_NOTICES = 20;                     // 待领取通知上限（渲染层崩了可能长期不取）

function createCrashGuard(deps = {}) {
  const reportError = typeof deps.reportError === 'function' ? deps.reportError : () => {};
  const getWindow = typeof deps.getMainWindow === 'function' ? deps.getMainWindow : () => null;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const reloadWindowMs = Number(deps.reloadWindowMs) > 0 ? Number(deps.reloadWindowMs) : DEFAULT_RELOAD_WINDOW_MS;
  const maxReloads = Number(deps.maxReloads) > 0 ? Number(deps.maxReloads) : DEFAULT_MAX_RELOADS;

  let reloadTimes = [];
  let notices = [];
  let unresponsiveSince = 0;

  function rememberNotice(kind, detail) {
    notices.push({ kind, at: new Date(now()).toISOString(), detail });
    if (notices.length > MAX_NOTICES) notices.shift();
  }

  /** 渲染层启动时领取「上次崩过」的通知（取完即清，避免每次启动重复提示） */
  function takeNotices() {
    const out = notices;
    notices = [];
    return out;
  }

  function onRenderProcessGone(event, webContents, details = {}) {
    const reason = String(details.reason || 'unknown');
    const exitCode = Number(details.exitCode ?? 0);
    // clean-exit：正常关闭（窗口销毁等），不算事故，不重载
    if (reason === 'clean-exit') return { action: 'none', reason };

    reportError(
      'render-process-gone',
      new Error(`渲染进程退出：${reason}（exitCode=${exitCode}）`),
      { reason, exitCode, url: String(webContents?.getURL?.() || '').slice(0, 500) },
    );

    // 防死循环：窗口期内重载次数达上限 → 只记录，不再重载
    const t = now();
    reloadTimes = reloadTimes.filter((ts) => t - ts < reloadWindowMs);
    if (reloadTimes.length >= maxReloads) {
      reportError(
        'render-process-gone-loop',
        new Error(`渲染进程在 ${Math.round(reloadWindowMs / 1000)}s 内第 ${reloadTimes.length + 1} 次崩溃，已停止自动重载`),
        { reason, windowMs: reloadWindowMs, maxReloads },
      );
      rememberNotice('loop', { reason, count: reloadTimes.length + 1 });
      return { action: 'skip', reason, throttled: true };
    }

    reloadTimes.push(t);
    rememberNotice('reload', { reason, exitCode });
    const win = getWindow();
    try {
      if (win && typeof win.isDestroyed === 'function' && !win.isDestroyed()) {
        win.reload();
        return { action: 'reload', reason };
      }
    } catch (e) {
      reportError('render-process-gone', new Error(`自动重载失败：${e?.message || e}`), { reason });
    }
    return { action: 'no-window', reason };
  }

  function onChildProcessGone(event, details = {}) {
    const type = String(details.type || 'unknown');
    const reason = String(details.reason || 'unknown');
    const exitCode = Number(details.exitCode ?? 0);
    // 正常退出（进程池收缩）不记，避免日志噪声
    if (reason === 'clean-exit') return { action: 'none', type, reason };
    reportError(
      'child-process-gone',
      new Error(`子进程退出：${type}/${reason}（exitCode=${exitCode}）`),
      { type, reason, exitCode, serviceName: details.serviceName || '', name: details.name || '' },
    );
    rememberNotice('child-gone', { type, reason });
    return { action: 'record', type, reason };
  }

  function onUnresponsive() {
    unresponsiveSince = now();
    reportError('renderer-unresponsive', new Error('界面无响应（unresponsive）'), {});
    rememberNotice('unresponsive', {});
    return { action: 'record' };
  }

  function onResponsive() {
    const durationMs = unresponsiveSince ? now() - unresponsiveSince : 0;
    unresponsiveSince = 0;
    return { action: 'record', durationMs };
  }

  /** app 级事件（渲染进程 / 子进程） */
  function attach(app) {
    if (!app || typeof app.on !== 'function') return false;
    app.on('render-process-gone', onRenderProcessGone);
    app.on('child-process-gone', onChildProcessGone);
    return true;
  }

  /** 窗口级事件（unresponsive / responsive 只存在于 BrowserWindow） */
  function attachWindow(win) {
    if (!win || typeof win.on !== 'function') return false;
    win.on('unresponsive', onUnresponsive);
    win.on('responsive', onResponsive);
    return true;
  }

  return {
    attach,
    attachWindow,
    onRenderProcessGone,
    onChildProcessGone,
    onUnresponsive,
    onResponsive,
    takeNotices,
    stats: () => ({ reloadTimes: [...reloadTimes], unresponsiveSince, pendingNotices: notices.length }),
  };
}

module.exports = { createCrashGuard, DEFAULT_RELOAD_WINDOW_MS, DEFAULT_MAX_RELOADS };

// 团队调试日志 IPC 域（teams:debug*，2026-10-21）
//
// 目标：用户按一下「导出日志」，就能把团队操作全链路的事实流发给开发者。
// 职责边界（只做通道，不做业务判断）：
//   · status   —— 当前是否记录、详细模式、日志文件路径/大小/内存条数；
//   · set      —— 开关记录 / 切换详细模式（用户可随时关闭，避免长期占用磁盘）；
//   · tail     —— 给界面展示最近 N 条（与落盘同一份条目，不做二次加工）；
//   · append   —— 渲染层操作埋点（点击派活/打开看板等），与主进程日志同一时间线；
//   · export   —— 打包最近日志为 zip（落 userData/diagnostics，导出后打开所在目录）；
//   · openDir  —— 直接打开日志目录。
const { ipcMain, shell } = require('electron');
const teamDebug = require('../teamDebugLog');

function initTeamDebugIpc() {
  ipcMain.handle('teams:debugSet', async (_, payload = {}) => {
    if (typeof payload.enabled === 'boolean') teamDebug.setEnabled(payload.enabled);
    if (typeof payload.verbose === 'boolean') teamDebug.setVerbose(payload.verbose);
    return teamDebug.status();
  });

  ipcMain.handle('teams:debugTail', async (_, payload = {}) => ({
    ok: true,
    entries: teamDebug.tail(payload.limit),
    status: teamDebug.status(),
  }));

  ipcMain.handle('teams:debugAppend', async (_, payload = {}) => {
    const entry = teamDebug.appendFromRenderer(payload);
    return { ok: !!entry, entry };
  });

  ipcMain.handle('teams:debugExport', async () => {
    const r = teamDebug.exportBundle();
    // 导出成功即打开所在目录：用户不用自己找路径（日志是给开发者排查用的，不应让用户找文件）
    if (r.ok && r.path) {
      try { shell.showItemInFolder(r.path); } catch { /* 打开失败不影响导出结果 */ }
    }
    return r;
  });

  ipcMain.handle('teams:debugOpenDir', async () => {
    const st = teamDebug.status();
    if (!st.dir) return { ok: false, error: '日志目录未初始化' };
    try {
      const err = await shell.openPath(st.dir);
      return err ? { ok: false, error: err } : { ok: true, path: st.dir };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });
}

module.exports = { initTeamDebugIpc };

// P0-8c：开机自启 IPC（ScheduledTasks 页 toggle 消费）——从 main.js 抽出独立模块：
// ① main.js 逼近 1500 行 max-lines 硬门禁；② app.setLoginItemSettings 属系统能力，
// 与调度器解耦，本地偏好持久化经注入的 store（与 main.js 的 localStore 同源）。
const { ipcMain, app } = require('electron');
const guard = require('./ipc/payloadGuard');

const PREF_KEY = 'scheduler.auto_launch';

function initAutoLaunchIpc({ getStore } = {}) {
  ipcMain.handle('app:autoLaunchGet', async () => {
    try {
      return { ok: true, enabled: !!getStore()?.getPreference?.(PREF_KEY) };
    } catch (e) {
      console.warn('[app] 开机自启状态读取失败:', e.message);
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('app:autoLaunchSet', async (_, p = {}) => {
    // X14：原实现 `!!p.enabled` 会把字符串 'false' / 非空对象判成 true —— 用户点「关闭」
    // 反而把开机自启打开（且界面显示已关闭）。显式要求布尔值，形状不合法即拒绝。
    try {
      guard.assertObject(p);
      if (typeof p.enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const enabled = p.enabled;
    try {
      app.setLoginItemSettings({ openAtLogin: enabled });
    } catch (e) {
      console.warn('[app] 开机自启设置失败:', e.message);
      return { ok: false, error: e.message };
    }
    try { getStore()?.setPreference?.(PREF_KEY, enabled); }
    catch (e) { console.warn('[app] 开机自启偏好持久化失败:', e.message); }
    return { ok: true, enabled };
  });
}

module.exports = { initAutoLaunchIpc };

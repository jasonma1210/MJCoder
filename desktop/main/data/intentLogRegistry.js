// main/data/intentLogRegistry.js
// 持久化意图日志的名单例注册表。
//
// 为什么需要它：若各域各自在 main.js 启动段 new IntentLog(...)，会出现两份初始化
// + 两份退出 flush 责任，will-quit 清单必漏其中一份。本表把"惰性 open"与
// "退出统一 flush"收口到一处，域内只持逻辑句柄。
//
// 边界（team-lead 裁决 ②）：本表【只收持久化意图日志】。遥测/审计型 JSONL
// （如编排决策日志）用 durableWrite 的 appendDurable 原语直写、每条 fsync、
// 无缓冲，因此无 flush 责任，不进本表、不进 will-quit 清单。

const { IntentLog } = require('./intentLog');

const registry = new Map(); // name → IntentLog

/**
 * 按名单例获取（不存在则创建并 open）。同 name 二次调用返回同一实例。
 * @param {string} name 逻辑名（如 'user-data'），用于日志与调试
 * @param {string} file 日志文件绝对路径
 * @param {Object} [opts] 透传给 IntentLog 构造函数
 * @returns {IntentLog}
 */
function getIntentLog(name, file, opts = {}) {
  const existing = registry.get(name);
  if (existing) return existing;
  const log = new IntentLog(file, opts);
  const r = log.open();
  if (!r.ok) throw new Error(`[intentLogRegistry] '${name}' 打开失败：${r.error}`);
  registry.set(name, log);
  return log;
}

/** 已注册的逻辑名列表（调试/诊断用）。 */
function listIntentLogs() { return [...registry.keys()]; }

/**
 * will-quit 统一调用：排空所有持久化意图日志的 T1 缓冲。
 * 单个日志失败不影响其余——退出路径不该因一个域的问题放弃其他域的落盘。
 * @returns {Array<{name: string, ok: boolean, records?: number, durable?: boolean, error?: string}>}
 */
function flushAllIntentLogs() {
  const out = [];
  for (const [name, log] of registry) {
    try {
      const r = log.flush();
      out.push({ name, ok: true, ...r });
      if (!r.durable) console.warn(`[intentLogRegistry] '${name}' flush 后仍有 ${r.records} 条未落盘`);
    } catch (e) {
      out.push({ name, ok: false, error: String(e && e.message || e) });
      console.error(`[intentLogRegistry] '${name}' flush 失败:`, e && e.message);
    }
  }
  return out;
}

/**
 * 启动时对超过阈值的日志触发恢复性 compact（防崩溃后日志无限增长）。
 * 由调用方提供 snapshotOf(name) → 快照数据与落点；本函数只负责判定与调用。
 * @param {(name: string) => {data: *, file: string} | null} snapshotOf
 * @param {number} [thresholdBytes=4 * 1024 * 1024]
 */
function compactIfLarge(snapshotOf, thresholdBytes = 4 * 1024 * 1024) {
  const out = [];
  for (const [name, log] of registry) {
    try {
      if (log.logSizeBytes() < thresholdBytes) continue;
      const snap = snapshotOf(name);
      if (!snap) { out.push({ name, ok: false, error: '无快照提供方，跳过' }); continue; }
      const r = log.compact(snap.data, snap.file);
      out.push({ name, ok: r.ok, error: r.error, bytesBefore: snap.file });
      if (r.ok) console.log(`[intentLogRegistry] '${name}' 恢复性 compact 完成（原 ${(thresholdBytes / 1048576).toFixed(1)}MB+）`);
    } catch (e) {
      out.push({ name, ok: false, error: String(e && e.message || e) });
    }
  }
  return out;
}

/** 测试用：全部关闭并清空注册表。 */
function closeAllIntentLogs() {
  for (const log of registry.values()) {
    try { log.close(); } catch (e) { console.error('[intentLogRegistry] close 失败:', e && e.message); }
  }
  registry.clear();
}

module.exports = {
  getIntentLog,
  listIntentLogs,
  flushAllIntentLogs,
  compactIfLarge,
  closeAllIntentLogs,
};

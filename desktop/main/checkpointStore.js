// Agent 任务断点持久化（Phase 3-1：预算中断 = 暂停，不是失败）
// 背景：长任务 token 预算触顶熔断后，用户发「继续」只能靠重放全部历史消息恢复——
// 重进线程/重启应用后断点信息（做到哪一步、待办是什么）完全丢失。
// 设计：按会话 threadKey 保存最近一次熔断断点（结构化摘要 + 用量 + 元数据）到
// userData/agent-checkpoints.json；渲染层发「继续」时取回断点注入运行上下文，
// 成功启动即清除——断点是「一次性恢复垫脚石」，不累积。
// 容量：最多保留 50 个会话的断点（LRU 淘汰）。
//
// P1-15 修复（2026-10-17）两处：
//   ① 写改原子写（tmp+fsync+rename，复用 main/data/durableWrite.js 单一事实来源）——
//      原裸 writeFileSync 写一半崩溃即截断文件，下次启动全部断点读不出；
//   ② 损坏 fail-closed——原实现 catch 后一律「视为空」：断点全部静默消失，
//      且随后任何一次 save 都会把损坏文件覆盖成单条目，证据与数据双失。
//      现：损坏文件先留 .corrupt-<ts> 副本（可恢复），错误态经 getLoadError()
//      可查询（UI/诊断可见），控制台留可行动告警；之后的新保存才允许覆盖。
const fs = require('fs');
const path = require('path');
// P1-15：原子写原语（tmp+fsync+rename）——全项目单一事实来源
const { writeFileDurableWithMode } = require('./data/durableWrite');

const MAX_ENTRIES = 50;

let file = null; // userData/agent-checkpoints.json
let loadError = null; // P1-15：最近一次加载损坏的错误态（null = 正常；UI/诊断可查询）

function initCheckpointStore(userDataPath) {
  file = userDataPath
    ? `${userDataPath}/agent-checkpoints.json`.replace(/\/+/g, '/')
    : null;
  loadError = null;
}

// P1-15：查询断点存储的加载错误态（损坏时非 null，含备份路径与原因）。
// 返回 { file, backup, reason, at }；未损坏返回 null。
function getLoadError() {
  return loadError;
}

function loadAll() {
  if (!file) return {};
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    loadError = null; // 加载成功即清除错误态（用户可能已从备份恢复）
    return j && typeof j === 'object' ? j : {};
  } catch (e) {
    // P1-15：fail-closed——不静默丢弃。损坏文件留副本（可人工恢复），错误态可查询，
    // 控制台给可行动指引；返回空 map 让调用方不崩溃，但「丢失」这件事不再无声。
    let backup = null;
    try {
      backup = `${file}.corrupt-${Date.now()}`;
      fs.copyFileSync(file, backup);
    } catch (e2) {
      backup = null;
      console.warn('[checkpoint] 损坏文件备份失败:', e2.message);
    }
    const reason = String(e?.message || e);
    loadError = { file, backup, reason, at: new Date().toISOString() };
    console.error(
      `[checkpoint] 断点存储损坏：${reason}。已保留副本 ${backup || '（备份失败）'}，`
      + `可手动恢复后重启；本次按无断点处理（不静默丢弃）。`,
    );
    return {};
  }
}

function saveAll(map) {
  if (!file) return false;
  // P1-15：原子写（tmp+fsync+rename + 0600）——断点含任务摘要，权限收紧不组/众可读
  const res = writeFileDurableWithMode(file, JSON.stringify(map, null, 2), 0o600);
  if (!res.ok) {
    console.warn('[checkpoint] 断点保存失败:', res.error);
    return false;
  }
  if (!res.modeApplied) {
    console.warn('[checkpoint] 断点文件权限收紧失败（0600 未生效）:', res.error || 'chmod 失败');
  }
  return true;
}

// 保存断点；返回是否成功。同 threadKey 重复熔断时覆盖（只留最近一次）。
function saveCheckpoint(threadKey, data) {
  const key = String(threadKey || 'local');
  const map = loadAll();
  // LRU 淘汰：超过容量删最早的条目（保存顺序即插入顺序）
  const keys = Object.keys(map);
  if (!map[key] && keys.length >= MAX_ENTRIES) {
    delete map[keys[0]];
  }
  map[key] = { ...data, savedAt: Date.now() };
  return saveAll(map);
}

function getCheckpoint(threadKey) {
  return loadAll()[String(threadKey || 'local')] || null;
}

function clearCheckpoint(threadKey) {
  const key = String(threadKey || 'local');
  const map = loadAll();
  if (!(key in map)) return false;
  delete map[key];
  saveAll(map);
  return true;
}

module.exports = {
  initCheckpointStore, saveCheckpoint, getCheckpoint, clearCheckpoint, getLoadError, MAX_ENTRIES,
};

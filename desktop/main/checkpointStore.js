// Agent 任务断点持久化（Phase 3-1：预算中断 = 暂停，不是失败）
// 背景：长任务 token 预算触顶熔断后，用户发「继续」只能靠重放全部历史消息恢复——
// 重进线程/重启应用后断点信息（做到哪一步、待办是什么）完全丢失。
// 设计：按会话 threadKey 保存最近一次熔断断点（结构化摘要 + 用量 + 元数据）到
// userData/agent-checkpoints.json；渲染层发「继续」时取回断点注入运行上下文，
// 成功启动即清除——断点是「一次性恢复垫脚石」，不累积。
// 容量：最多保留 50 个会话的断点（LRU 淘汰），文件损坏时静默重建（fail-open）。

const MAX_ENTRIES = 50;

let file = null; // userData/agent-checkpoints.json

function initCheckpointStore(userDataPath) {
  file = userDataPath
    ? `${userDataPath}/agent-checkpoints.json`.replace(/\/+/g, '/')
    : null;
}

function loadAll() {
  if (!file) return {};
  const fs = require('fs');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : {};
  } catch (e) {
    return {}; // 不存在/损坏：视为空（fail-open，绝不因断点存储拖垮主流程）
  }
}

function saveAll(map) {
  if (!file) return false;
  const fs = require('fs');
  try {
    fs.mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn('[checkpoint] 断点保存失败:', e.message);
    return false;
  }
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

module.exports = { initCheckpointStore, saveCheckpoint, getCheckpoint, clearCheckpoint, MAX_ENTRIES };

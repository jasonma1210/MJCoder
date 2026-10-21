'use strict';
// B-15 收口（2026-10-21）：组级并发上限（探活撤员只降本组，不波及其它 run）。
//
// 从 `workerPool.js` 抽出（抽出的直接原因：B-15 补上后该文件越过 800 行软档；
// 本模块是纯状态 + 纯函数，与「怎么跑一个任务」无关，属可搬边界）。
//
// 语义：
//   · 未登记的组 = 全局并发上限；
//   · 撤员时只把**本组**上限减半一次（`lower`），组收尾（`restore`）即删除登记；
//   · `activeCountFor` 按 runKey 前缀计数，供泵在 claimNext **之前**判定。
function createGroupConcurrency({ activeRuns, getMaxConcurrent }) {
  const caps = new Map(); // groupId -> 本组并发上限

  function limitOf(groupId) {
    const cap = Number(caps.get(String(groupId)));
    const global = Math.max(1, Number(getMaxConcurrent()) || 1);
    return Number.isFinite(cap) && cap > 0 ? Math.min(global, cap) : global;
  }

  function activeCountFor(groupId) {
    const prefix = `${groupId}/`;
    let n = 0;
    for (const key of activeRuns.keys()) if (key.startsWith(prefix)) n += 1;
    return n;
  }

  function lower(groupId) {
    const gid = String(groupId);
    const cur = limitOf(gid);
    const next = Math.max(1, Math.floor(cur / 2));
    if (next < cur) caps.set(gid, next);
    return next;
  }

  function restore(groupId) {
    caps.delete(String(groupId));
  }

  return { limitOf, activeCountFor, lower, restore, caps };
}

module.exports = { createGroupConcurrency };

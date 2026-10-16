// P2 记忆体系测试：scorer 六因子 / MemoryManager 五域四层 / 分层召回 / 压缩晋升衰减清理 / BgScheduler
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const { MemoryManager } = require('../main/memory');
const { MemoryBgScheduler } = require('../main/memory/bgScheduler');
const scorer = require('../main/memory/scorer');

let n = 0;
function ok(name) { n += 1; console.log(`  ✓ ${name}`); }

(async () => {
  // ── 1. scorer 六因子 ──
  assert.ok(scorer.relevance('数据库迁移 schema', '项目的 schema 迁移与数据库升级流程') > 0.2, '词法相关性');
  assert.strictEqual(scorer.relevance('完全无关的话题xyz', '数据库迁移'), 0);
  const old = { is_valid: 1, importance: 0.8, usage_count: 0, tier: 1, updated_at: Date.now() - 28 * 24 * 3600 * 1000 };
  const fresh = { is_valid: 1, importance: 0.8, usage_count: 0, tier: 1, updated_at: Date.now() };
  assert.ok(scorer.recencyScore(old.updated_at) < 0.3 && scorer.recencyScore(fresh.updated_at) > 0.9, '半衰期 14 天衰减');
  assert.ok(scorer.scoreMemory(old).total < scorer.scoreMemory(fresh).total, '旧记忆总分更低');
  assert.strictEqual(scorer.scoreMemory({ ...fresh, is_valid: 0 }).total, 0, '失效硬闸归零');
  ok('scorer：相关性/衰减/失效闸');

  // ── 2. MemoryManager：五域写入 + 分层召回 ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-mem-'));
  const mem = new MemoryManager({ db: await openDbAsync(dir, { driver: 'sqljs' }) });
  mem.remember({ spaceId: '/proj', domain: 'global_knowledge', content: '项目使用 pnpm monorepo，13 个包', importance: 0.9 });
  mem.remember({ spaceId: '/proj', domain: 'session', content: '今天修复了审批通道竞态 Bug', importance: 0.6 });
  mem.remember({ spaceId: '/other', domain: 'session', content: '别的项目的记忆不应该出现' });
  const hits = mem.recall({ spaceId: '/proj', query: 'monorepo 包结构', topK: 5 });
  assert.ok(hits.length >= 1 && hits[0].content.includes('pnpm monorepo'), '按查询相关性命中');
  assert.ok(!hits.some((h) => h.content.includes('别的项目')), '空间隔离（跨项目不可见）');
  assert.strictEqual(mem.get(hits[0].id).reHitCount, 1, '命中计数自增');
  const noQuery = mem.recallContents({ spaceId: '/proj', topK: 5 });
  assert.ok(noQuery.length === 2, '无查询退化为 importance×recency Top-K');
  ok('MemoryManager：五域写入/空间隔离/召回路由/命中计数');

  // ── 3. 压缩（Tier1→Tier2，stub LLM）──
  for (let i = 0; i < 5; i += 1) {
    mem.remember({ spaceId: '/proj', domain: 'session', content: `会话记录 ${i}：讨论了模块 ${i} 的实现方案`, importance: 0.5 });
  }
  let llmCalls = 0;
  const c = await mem.compress({
    spaceId: '/proj', domain: 'session', batchSize: 10,
    chatOnce: async () => { llmCalls += 1; return { content: '要点：本次会话讨论了模块 0-4 的实现方案并达成结论。' }; },
    model: { providerId: 1, isGlobal: true, baseUrl: '', model: 'm' },
  });
  assert.strictEqual(llmCalls, 1, '批量合并为 1 次 LLM 调用');
  assert.strictEqual(c.wrote, 1, '压缩产出 1 条 Tier2');
  assert.strictEqual(c.compressed, 6, `合并 6 条源 Tier1（1 旧 + 5 新）`);
  const t2 = mem.recall({ spaceId: '/proj', topK: 10 }).filter((m) => m.tier === 2);
  assert.ok(t2.length === 1 && t2[0].content.includes('模块 0-4'), 'Tier2 摘要在召回中');
  assert.ok(!mem.recall({ spaceId: '/proj', topK: 20 }).some((m) => m.compressed), '已压缩 Tier1 不再返回');
  ok('memoryCompressor：批量合并 → 1 次 LLM → Tier2 落库');

  // ── 4. 晋升：高频 Tier2 → Tier3 ──
  for (let i = 0; i < 3; i += 1) mem.recall({ spaceId: '/proj', query: '模块', topK: 1 });
  const promoted = mem.promoteByHits(3);
  assert.ok(promoted >= 1, `高频摘要晋升（${promoted} 条）`);
  assert.ok(mem.recall({ spaceId: '/proj', topK: 20 }).some((m) => m.tier === 3), 'Tier3 存在');
  ok('晋升：re_hit ≥3 的 Tier2 → Tier3 固化');

  // ── 5. 衰减 + 清理 ──
  mem.remember({ spaceId: '/proj', domain: 'session', content: '低价值临时记录', importance: 0.06 });
  mem.db.prepare('UPDATE memories SET updated_at = ? WHERE content = ?').run(Date.now() - 30 * 24 * 3600 * 1000, '低价值临时记录');
  const d = mem.decayJob({});
  assert.ok(d.invalidated >= 1, `低分失效（${d.invalidated} 条）`);
  mem.db.prepare('UPDATE memories SET updated_at = ? WHERE is_valid = 0').run(Date.now() - 10 * 24 * 3600 * 1000);
  const cl = mem.cleanupJob({});
  assert.ok(cl.purged >= 1, `失效过期清理（${cl.purged} 条）`);
  ok('衰减 + 清理（防膨胀）');

  // ── 6. BgScheduler：入队/执行/重试/卡死防线/恢复 ──
  const sched = new MemoryBgScheduler({ db: mem.db, memory: mem, emit: () => {} });
  sched.enqueue('decay', {}, { priority: 4 });
  sched.enqueue('cleanup', {}, { priority: 5 });
  const drained = await sched.drain(10);
  assert.ok(drained.length === 2 && drained.every((r) => r.result), '后台任务执行成功');
  // 失败重试：未知类型 → 回队 → attempts 累积 → 超限判死
  sched.enqueue('unknown-type', {}, { priority: 1 });
  await sched.runOne();
  const after1 = sched.listTasks({ limit: 5 }).find((t) => t.type === 'unknown-type');
  assert.strictEqual(after1.status, 'queued', '失败回队');
  let last = null;
  for (let i = 0; i < 5; i += 1) last = await sched.runOne();
  const dead = sched.listTasks({ limit: 10 }).find((t) => t.type === 'unknown-type');
  assert.strictEqual(dead.status, 'failed', '超过 3 次尝试判死（卡死防线）');
  // 重启恢复：queued 任务仍在表中（新实例可继续消费）
  sched.enqueue('cleanup', {}, { priority: 5 });
  const sched2 = new MemoryBgScheduler({ db: mem.db, memory: mem, emit: () => {} });
  const resumed = await sched2.drain(5);
  assert.ok(resumed.some((r) => r.task.type === 'cleanup'), '重启后 queued 任务被新调度器恢复续跑');
  // P0-19：purgeHistory 清理过期与超限的 done/failed 行，且不碰 queued/running
  for (let i = 0; i < 12; i += 1) {
    mem.db.prepare(`INSERT INTO memory_bg_tasks (id, type, payload, priority, status, attempts, created_at, updated_at)
      VALUES (?, 'decay', '{}', 4, 'done', 1, ?, ?)`).run(`old-done-${i}`, Date.now() - 10 * 86400000, Date.now() - 10 * 86400000);
  }
  for (let i = 0; i < 8; i += 1) {
    mem.db.prepare(`INSERT INTO memory_bg_tasks (id, type, payload, priority, status, attempts, created_at, updated_at)
      VALUES (?, 'decay', '{}', 4, 'done', 1, ?, ?)`).run(`recent-done-${i}`, Date.now(), Date.now() + i);
  }
  const keepTask = sched2.enqueue('promote', {}, { priority: 3 });
  const pr = sched2.purgeHistory({ retentionMs: 7 * 86400000, maxRows: 5 });
  assert.strictEqual(pr.expired, 12, '超过 7 天的 done 行被物理清理');
  assert.ok(pr.trimmed >= 3, '超出 maxRows 上限的旧终态行被裁剪');
  const terminalLeft = mem.db.prepare(`SELECT COUNT(*) AS n FROM memory_bg_tasks WHERE status IN ('done','failed')`).get().n;
  assert.strictEqual(terminalLeft, 5, '终态行严格收敛至 maxRows=5');
  const queuedStillThere = mem.db.prepare(`SELECT status FROM memory_bg_tasks WHERE id = ?`).get(keepTask.id);
  assert.strictEqual(queuedStillThere?.status, 'queued', 'purgeHistory 绝不误删 queued 任务');
  await sched2.drain(5);
  ok('BgScheduler：入队/执行/失败回队/3 次判死/重启恢复/P0-19 历史生命周期治理');

  // ── 7. 统计（可视化数据源）──
  const st = mem.stats();
  assert.ok(st.total > 0 && st.byDomainTier.length > 0 && Array.isArray(st.bgTasks), 'stats 结构完整');
  ok('stats 统计');

  console.log(`\nP2 记忆体系：${n} 项全部通过`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

// 团队记忆族（M5 / T5-5）：从 memory/index.js 抽出（2026-10-20）——与 recall.js 同批拆分，
// 触发原因同为「新增团队记忆后越过 800 行软档门禁，先拆再合入」；语义与实现**原样迁移**，
// 不夹带任何行为变更。本族只含「自洽可搬」的团队专属方法：
//   · _enforceTeamCap —— 团队层独立容量闸（按 team_id 计数）；
//   · recallTeamMemories —— 团队层专供召回入口（共享 ∪ 自身私有）；
//   · listTeamPromotionCandidates —— 提名制候选读取（U5：只列不写）；
//   · promoteTeamMemoryToProject —— 用户确认后团队→项目的显式晋升通道。
// 注意：scope='team' 的写入/去重/归属判定仍留在 index.js（与 remember/_findDup/resolveScope 强耦合，
//   搬走会割裂写入链路的单一事实来源，得不偿失）。
//
// 依赖注入（同 recall.js：避免 index → team → index 循环依赖）：常量与可信度函数由 index.js 注入；
// 其余依赖（this._enforceCap / this._rowToMemory / this.promoteScope / this.get）都是实例方法，直接经 this 调用。
const { scoreMemory } = require('./scorer');

/**
 * 构造团队记忆族方法集合，供 index.js 装配到 MemoryManager.prototype。
 * @param {object} deps index.js 的团队层常量与可信度函数
 * @returns {object} 方法集合（_enforceTeamCap / recallTeamMemories /
 *   listTeamPromotionCandidates / promoteTeamMemoryToProject）
 */
function createTeamMethods({ PROMOTE_TEAM_MIN_HITS, MAX_TEAM_MEMORIES, RECALL_SCAN_LIMIT, RECALL_TOP_K_MAX, trustOf }) {
  return {
    // M5 / T5-5：团队层独立容量闸——按 team_id 计数（共享 + 全部成员私有一并受闸）。
    //   团队是临时编制，不留无限增长的工作痕迹；无瞬时域可优先淘汰，故按 updated_at 最旧硬淘汰。
    _enforceTeamCap(teamId) {
      if (!teamId) return 0;
      return this._enforceCap({
        label: `团队层（team=${teamId}）`, limit: MAX_TEAM_MEMORIES,
        where: "scope = 'team' AND team_id = ?", args: [String(teamId)], victimDomain: null,
      });
    },

    // M5 / T5-5：团队层专供召回入口（宿主 Web/Worker 注入用）——只取团队层，
    // 可见范围 = 团队共享 ∪ 自身私有（agentId 为空则仅共享）。返回与 recall 同构的条目数组。
    // 与 recallContents 的差别：不做跨层配额合并、不掺项目/全局层，语义更聚焦易审计。
    recallTeamMemories({ teamId, agentId = null, spaceId = null, query = '', topK = 5 } = {}) {
      if (!teamId) return [];
      const k = Math.min(Math.max(1, Number(topK) || 5), RECALL_TOP_K_MAX);
      const scan = RECALL_SCAN_LIMIT;
      const rows = this._layerRows({ space: spaceId || 'default', scope: 'team', teamId, agentId, scan });
      const scored = rows.map((r) => this._rowToMemory(r))
        .map((m) => ({ memory: m, score: scoreMemory(m, { query }), trust: trustOf(m) }))
        .map((x) => ({ memory: x.memory, score: { ...x.score, total: x.score.total * x.trust } }))
        .sort((a, b) => b.score.total - a.score.total)
        .slice(0, k);
      for (const { memory } of scored) {
        this.db.prepare('UPDATE memories SET re_hit_count = re_hit_count + 1, usage_count = usage_count + 1, updated_at = ? WHERE id = ?')
          .run(this._now(), memory.id);
      }
      return scored.map(({ memory, score }) => ({ ...memory, score: Number(score.total.toFixed(4)) }));
    },

    // M5 / T5-5（U5 提名制）：列出团队记忆「待晋升候选」——只列不写，是否写入项目层永远由用户确认。
    //   判据：scope='team' AND is_valid=1 AND re_hit_count >= minHits（默认 PROMOTE_TEAM_MIN_HITS）。
    //   两条反例保护（本模块不认识军团实体，团队名/归档态一律由宿主注入）：
    //     ① excludeNames —— 内容含团队专有名（团队名/Lead 名）的条目直接不进候选：这类条目晋升到
    //        项目层会跨团队污染（别的团队看到的是无关的专有名）；
    //     ② excludeTeamIds —— 排除已归档团队的记忆（归档团队的结论不参与跨团队复用）。
    listTeamPromotionCandidates({ minHits = PROMOTE_TEAM_MIN_HITS, excludeNames = [], excludeTeamIds = [], limit = 100 } = {}) {
      const lim = Math.min(Math.max(1, Number(limit) || 100), 200);
      const min = Math.max(1, Number(minHits) || PROMOTE_TEAM_MIN_HITS);
      const rows = this.db.prepare(`SELECT * FROM memories WHERE scope = 'team' AND is_valid = 1 AND re_hit_count >= ?
        ORDER BY re_hit_count DESC, updated_at DESC LIMIT ?`).all(min, lim);
      const banned = new Set((excludeTeamIds || []).map((x) => String(x)));
      const names = (excludeNames || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
      return rows.map((r) => this._rowToMemory(r))
        .filter((m) => !(m.teamId && banned.has(String(m.teamId))))
        .filter((m) => {
          if (!names.length) return true;
          const hay = `${m.content || ''}\n${m.summary || ''}`.toLowerCase();
          return !names.some((n) => hay.includes(n)); // 含团队专有名 → 不进候选
        });
    },

    // M5 / T5-5（U5）：用户确认后把一条团队记忆晋升为项目级（团队→项目唯一的显式通道之一）。
    //   语义：scope team→project；解绑 agent_id（成员私有结论升格为团队所在项目的公共资产）；
    //   team_id 保留为来源留痕（项目层召回不看 team_id，仅用于审计「这条从哪来」）。
    //   复用 promoteScope（唯一向上晋升路径，含双 _notify 刷新来源层/目标层视图）；
    //   非法（不存在 / 已失效 / 非团队层）返回 null。
    promoteTeamMemoryToProject(id) {
      const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
      if (!row || !row.is_valid) return null;
      if ((row.scope || '') !== 'team') return null;
      const promoted = this.promoteScope(id, 'project');
      if (!promoted) return null;
      // 解绑成员归属（升格为项目公共资产）；team_id 保留为来源留痕
      this.db.prepare('UPDATE memories SET agent_id = NULL, updated_at = ? WHERE id = ?').run(this._now(), id);
      return this.get(id);
    },
  };
}

module.exports = { createTeamMethods };

// P2-3：memoryScorer——记忆六因子加权打分（纯函数，无 IO）
// 因子（文档②第五节裁剪为可量化六项）：
//   relevance  查询相关性：词法重叠（CJK 二元组 + 拉丁词）Jaccard
//   recency    时间衰减：分域半衰期指数衰减（P1-17）
//   importance 人工/模型赋予的重要性 [0,1]
//   frequency  使用频次：usage_count 对数饱和
//   tierBoost  层级权重：Tier3 固化 > Tier2 摘要 > Tier1 原文
//   validity   失效硬闸：is_valid=0 直接出局（不参与加权）
// P1-17（2026-10-17）：分域半衰期——session 瞬时域 7 天，entity / global_knowledge /
//   reflection / private 30 天；未知域（如无 domain 字段的旧记忆对象）回落 14 天，
//   与修复前的单一 14 天口径兼容，不改变既有调用方的相对排序。
const HALF_LIFE_DAYS_BY_DOMAIN = {
  session: 7,
  entity: 30,
  global_knowledge: 30,
  reflection: 30,
  private: 30,
};
const HALF_LIFE_DAYS = 14; // 未知域回落值（保持导出名兼容）
const DAY_MS = 24 * 60 * 60 * 1000;

// P1-17：分域半衰期查询（未知域回落 14 天）
function halfLifeDaysFor(domain) {
  return HALF_LIFE_DAYS_BY_DOMAIN[domain] || HALF_LIFE_DAYS;
}

const WEIGHTS = {
  relevance: 0.40,
  recency: 0.20,
  importance: 0.20,
  frequency: 0.10,
  tierBoost: 0.10,
};

const TIER_BOOST = { 1: 0.3, 2: 0.6, 3: 1.0 };

// ── 词法特征：查询与文本的相关性度量（对中文友好：CJK 二元组；英文/代码：小写词）──
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = new Set();
  for (const m of s.matchAll(/[\u4e00-\u9fff]/g)) tokens.add(m[0]); // 单字（覆盖面）
  for (let i = 0; i < s.length - 1; i += 1) {
    if (/[\u4e00-\u9fff]/.test(s[i]) && /[\u4e00-\u9fff]/.test(s[i + 1])) tokens.add(s.slice(i, i + 2)); // CJK 二元组
  }
  for (const w of s.matchAll(/[a-z0-9_]{2,}/g)) tokens.add(w[0]);
  return tokens;
}

function relevance(query, text) {
  const q = tokenize(query);
  if (q.size === 0) return 0;
  const t = tokenize(text);
  let hit = 0;
  for (const tok of q) if (t.has(tok)) hit += 1;
  return hit / q.size;
}

// P1-17：recency 支持按域取半衰期（domain 缺省 = 未知域，回落 14 天，行为同修复前）
function recencyScore(updatedAt, now = Date.now(), domain = undefined) {
  const days = Math.max(0, (now - (updatedAt || now)) / DAY_MS);
  return Math.pow(0.5, days / halfLifeDaysFor(domain));
}

function frequencyScore(usageCount) {
  return Math.min(1, Math.log10(1 + Math.max(0, usageCount || 0)) / 2); // 100 次封顶
}

// 单条记忆总分（0~1）；query 为空时相关性因子权重按比例分摊给 recency/importance
function scoreMemory(memory, { query, now = Date.now() } = {}) {
  // 兼容 snake_case（DB 行）与 camelCase（_rowToMemory 输出）两种键名
  const isValid = memory.is_valid !== undefined ? !!memory.is_valid : memory.isValid !== false;
  if (!isValid) return { total: 0, factors: { validity: 0 } };
  const hasQuery = String(query || '').trim().length > 0;
  const text = `${memory.summary || ''}\n${memory.content || ''}`;
  const relevanceV = hasQuery ? relevance(query, text) : null;
  // P1-17：recency 按记忆所属域取半衰期（memory.domain 缺省时回落 14 天）
  const recencyV = recencyScore(memory.updated_at, now, memory.domain);
  const importanceV = Math.max(0, Math.min(1, Number(memory.importance) || 0));
  const frequencyV = frequencyScore(memory.usage_count);
  const tierV = TIER_BOOST[memory.tier] ?? 0.3;

  let total = 0;
  let wsum = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    const v = k === 'relevance'
      ? (hasQuery ? relevanceV : null)
      : k === 'recency' ? recencyV
        : k === 'importance' ? importanceV
          : k === 'frequency' ? frequencyV
            : tierV;
    if (v == null) continue; // 无查询时跳过相关性因子
    total += v * w;
    wsum += w;
  }
  return { total: wsum > 0 ? total / wsum : 0, factors: { relevance: relevanceV, recency: recencyV, importance: importanceV, frequency: frequencyV, tier: tierV } };
}

// P3-4 预留：embedding 余弦相似度（embedding 列就绪后与词法分融合）
function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

module.exports = { tokenize, relevance, recencyScore, frequencyScore, scoreMemory, cosineSim, halfLifeDaysFor, HALF_LIFE_DAYS, HALF_LIFE_DAYS_BY_DOMAIN };

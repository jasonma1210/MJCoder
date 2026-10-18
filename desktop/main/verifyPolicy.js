'use strict';
// V 层触发策略 + 无人值守交付裁决（纯函数，零依赖，可在纯 Node 下单测）。
//
// 为什么单独一层：主流平台的做法是「确定性校验全量跑、模型判分按风险与抽样开」
// （n8n 生态的公开口径是「离线全量、线上抽 5–10%、确定性指标全量」）。
// 把这条策略写进 verifyRun 会让「判定引擎」和「何时付费」耦在一起，
// 既没法单测策略，也没法让两条通道用不同口径。所以：
//   · verifyRun 只管「怎么判」
//   · 本模块只管「什么时候值得花一次模型调用」「判完之后敢不敢宣告成功」
//   · 调用方（定时通道 / 主对话）只做装配

// ── 不可逆 / 对外副作用的工具面 ──
// 分两档，因为它们的「事后可回滚性」完全不同：
//   external —— 出了本机或在机器外可见（推送、提交、对外写、定时创建），事后无法用 git 回滚
//   mutating —— 只在工作区里改（写文件/打补丁），diff 可见、能回滚
// 默认风险门只看 external：把本地写文件也算进去会让几乎每个编码类定时任务都触发 L3，
// 成本立刻退化成「每任务一次模型调用」，与本次设计的目标相反。
const EXTERNAL_TOOLS = new Set([
  'git_commit', 'git_add', 'git_push', 'scheduled_create', 'memory_promote',
  'unconfined_exec', 'pr_create', 'pr_comment', 'pr_review',
]);
const MUTATING_TOOLS = new Set([
  'write_file', 'edit_file', 'apply_patch', 'patch', 'apply_diff', 'memory_invalidate',
]);
// shell 里的对外/破坏性动作。宁可窄：宽正则会把 `git commit` 之外的日常命令也算进来。
const EXTERNAL_SHELL = /(^|[;&|]\s*)(rm\s|mv\s|dd\s|truncate\s|shred\s|chmod\s|chown\s|git\s+(push|reset\s+--hard|clean\s+-[a-z]*[fd])|npm\s+publish|docker\s+push|kubectl\s+(apply|delete)|curl[^|]*\s-X\s*(POST|PUT|PATCH|DELETE))/i;

// 守卫型触发：命中这些理由的 L3 才有权降级交付（抽样只做度量，见 decideDelivery）
const GUARD_TRIGGERS = new Set(['risk', 'on_block']);

function shellIsExternal(command) {
  return EXTERNAL_SHELL.test(String(command || ''));
}

/**
 * 本轮台账里是否存在「对外/不可逆」动作。
 * scope='external'（默认）只看 external 档；scope='any' 连本地写文件也算。
 * 只认 ok === true 的条目：失败的写/提交没有产生副作用，不该为它多花一次模型调用。
 */
function hasRiskyAction(ledger, scope = 'external') {
  if (!Array.isArray(ledger)) return false;
  return ledger.some((e) => {
    if (!e || e.ok !== true) return false;
    const name = String(e.name || '');
    if (name.startsWith('mcp__')) return true;      // 外部服务端副作用未知 → 按不可逆处理
    if (EXTERNAL_TOOLS.has(name)) return true;
    if (scope === 'any' && MUTATING_TOOLS.has(name)) return true;
    if (name === 'shell' && shellIsExternal(e.command)) return true;
    return false;
  });
}

/**
 * 是否值得为这一轮多花一次模型调用（L3）。
 *   level       —— 'off' | 'l1' | 'l3'，只有 l3 才可能跑
 *   verdict     —— L1 判定结果
 *   trigger     —— { risk?: boolean, onBlock?: boolean, sampleRate?: number, scope?: 'external'|'any' }
 *   rand        —— 注入随机源，便于单测（默认 Math.random）
 * 判定顺序（先便宜后昂贵，且**先确定性后随机**，保证同一输入的可预测性）：
 *   1. 档位不是 l3 → 不跑
 *   2. L1 BLOCK → 只有显式 onBlock 才跑（默认不跑：确定性结论不需要第二意见，
 *      而且 L3 只能补充理由，不能推翻 BLOCK —— 见 verifyRun 的注释）
 *   3. 命中风险门 → 跑
 *   4. 抽样命中 → 跑
 */
function shouldRunL3({ level = 'l1', verdict = '', ledger = null, trigger = null, rand = Math.random } = {}) {
  if (level !== 'l3') return { run: false, why: 'level_not_l3' };
  const t = trigger && typeof trigger === 'object' ? trigger : {};
  if (verdict === 'BLOCK') {
    return t.onBlock === true ? { run: true, why: 'on_block' } : { run: false, why: 'block_short_circuit' };
  }
  if (t.risk !== false && hasRiskyAction(ledger, t.scope === 'any' ? 'any' : 'external')) {
    return { run: true, why: 'risk' };
  }
  const rate = Number(t.sampleRate);
  if (Number.isFinite(rate) && rate > 0) {
    const r = typeof rand === 'function' ? Number(rand()) : 1;
    if (r < rate) return { run: true, why: 'sample' };
  }
  return { run: false, why: 'not_triggered' };
}

/**
 * 无人值守通道的交付裁决（fail-closed）。
 *
 * 主对话是 fail-open（判不出来就放行，人就在屏幕前，看到提示会自己判断）；
 * 定时通道必须反过来：**无法确认就绝不宣告成功**，否则「半夜跑挂了、早上显示成功」
 * 是这类产品最贵的一类事故。
 *
 * 返回 { downgrade: boolean, reason: string }
 *   downgrade=true 表示调用方不得把本次运行标成 success（产物仍照常归档，便于人工复核）。
 */
function decideDelivery({ verify = null, failClosed = false } = {}) {
  if (!verify || typeof verify !== 'object') return { downgrade: false, reason: '' };
  const verdict = String(verify.verdict || '');
  if (verdict === 'BLOCK') {
    return {
      downgrade: true,
      reason: `V 层对账未通过：${String(verify.reason || '自述完成但缺少证据')}`,
    };
  }
  if (!failClosed) return { downgrade: false, reason: '' };
  const l3 = verify.l3 && typeof verify.l3 === 'object' ? verify.l3 : null;
  if (!l3) return { downgrade: false, reason: '' };
  // 闸门判定「这一轮不值得跑 L3」≠「L3 失败了」：前者是设计内的省钱，不能算未验证。
  if (l3.triggered === false) return { downgrade: false, reason: '' };
  // 抽样型 L3 只用于度量，不降级交付；只有守卫型触发（风险门 / BLOCK 复核）才算数。
  if (!GUARD_TRIGGERS.has(String(l3.why || ''))) return { downgrade: false, reason: '' };
  if (l3.skipped) {
    // 请求了 L3 却没跑成（宿主没注入 chat / 超时 / 解析失败）：
    // 无人值守下「没验」与「验不过」一样不能宣告成功。
    return {
      downgrade: true,
      reason: `独立评审未产出判定（${String(l3.reason || 'unknown')}），无人值守按未验证处理`,
    };
  }
  if (String(l3.verdict) === 'FLAG') {
    return {
      downgrade: true,
      reason: `独立评审提示证据不足：${(Array.isArray(l3.reasons) ? l3.reasons : []).slice(0, 2).map(String).join('；') || '未给出理由'}`,
    };
  }
  return { downgrade: false, reason: '' };
}

/**
 * 任务级熔断：连续失败到阈值就自动暂停任务并留痕。
 * 半夜连挂 8 小时没人知道，比「某一次判分错」贵得多 —— 熔断先止血，人早上再查。
 */
function shouldAutoPause({ failStreak = 0, threshold = 3 } = {}) {
  const n = Number(failStreak) || 0;
  const th = Number(threshold) > 0 ? Number(threshold) : 3;
  return n >= th;
}

module.exports = {
  hasRiskyAction, shellIsExternal, shouldRunL3, decideDelivery, shouldAutoPause,
  EXTERNAL_TOOLS, MUTATING_TOOLS, GUARD_TRIGGERS,
};

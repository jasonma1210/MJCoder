// DS Bots / T6-6：工件协同原生工具（设计稿 §9.1–§9.3）——模型侧四个原语。
//
//   artifact_index         只读：章节树 + 当前版本 + 每章节字数 + 最近变更（≤1.2k tokens）
//   artifact_get_section   只读：按片段读正文（单次 ≤8000 字符，支持 offset/version）
//   artifact_patch_section 写入：按章节增量写（乐观锁 base_version），返回 {version, chars} 不含正文
//   artifact_get_diff      只读：两个版本之间的行级 diff（≤4000 字符）
//
// 四条硬边界（全部在 handler 内闭环，模型参数不可伪造）：
//   ① 项目身份取自宿主注入的 artifactContext（由会话绑定反查），模型传 project_id 只做**一致性校验**，
//      不一致直接拒绝——否则任何成员都能借工具读别的项目工件（§14 越权防护）；
//   ② 工件归属必须等于上下文项目，跨项目一律拒绝；
//   ③ 返回体体积闸在本层：索引按字符预算裁剪，读取/差异复用 ArtifactStore 的既有上限；
//   ④ patch 成功后由**宿主**向团队总线写 kind='artifact_ref'（只写摘要 + 引用，正文永不进消息，§9.3）。
const approval = require('./approval');

// 索引体积预算：设计稿 ≤1.2k tokens。按「中文 1 字≈1 token、英文约 4 字符/token」取中位 4800 字符，
// 与 agent-core 的 estimateTokens 口径一致（CJK 逐字 + 其余 /4）。
const INDEX_CHAR_BUDGET = 4800;
// 索引里最多给最近 5 条变更：再多对「我要改哪一章」没有增量信息，只是占预算
const INDEX_RECENT_LIMIT = 5;

function fail(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

/** ArtifactStore 的结构化错误 → 工具返回体（冲突附 currentVersion/yourBaseVersion/diff） */
function fromArtifactError(e) {
  const code = (e && e.code) || 'ARTIFACT_ERROR';
  const details = (e && e.details) || {};
  return fail(code, (e && e.message) || String(e), details);
}

function pickArtifactId(args = {}) {
  return String(args.artifactId || args.artifact_id || '').trim();
}

/**
 * 索引预算裁剪（§9.1 ≤1.2k tokens）：先丢最近变更，再压缩章节条目，最后按条数截断。
 * 逐级降级而不是直接截字符串——截断 JSON 会让模型拿到不可解析的半截结构。
 */
function fitIndex(ix) {
  const size = (o) => JSON.stringify(o).length;
  const note = '索引已按体积预算裁剪：需要正文请用 artifact_get_section 按片段读取';
  if (size(ix) <= INDEX_CHAR_BUDGET) return { ...ix, truncated: false };
  const noRecent = { ...ix, recentChanges: [] };
  if (size(noRecent) <= INDEX_CHAR_BUDGET) return { ...noRecent, truncated: true, note };
  const compact = {
    ...noRecent,
    outline: ix.outline.map((s) => ({
      key: s.key, title: String(s.title || '').slice(0, 40), chars: s.chars, version: s.version,
    })),
  };
  if (size(compact) <= INDEX_CHAR_BUDGET) return { ...compact, truncated: true, note };
  const kept = [];
  for (const s of compact.outline) {
    kept.push(s);
    if (size({ ...compact, outline: kept }) > INDEX_CHAR_BUDGET - 120) { kept.pop(); break; }
  }
  return {
    ...compact,
    outline: kept,
    outlineTotal: ix.outline.length,
    truncated: true,
    note: `${note}（大纲仅列出前 ${kept.length}/${ix.outline.length} 章，其余请按 key 直接读取）`,
  };
}

/**
 * @param {object} opts
 * @param {{projectId:string, artifactId?:string, teamId?:string, runId?:string, memberId?:string}|null} opts.artifactContext
 * @param {() => object|null} opts.getArtifactStore
 * @param {((input:object) => object|null)|null} opts.postMessage  团队总线写入（成员任务才有）
 * @param {object} [opts.approvalDeps]  { requestApproval, applyApprovalDecision, getAlwaysRules, conversationRules }
 */
function createArtifactToolHandlers({
  artifactContext = null, getArtifactStore, postMessage = null, approvalDeps = null,
} = {}) {
  const ctx = artifactContext || null;
  const ad = approvalDeps || {};

  // 上下文与存储自检：宿主若在没有项目绑定的运行上注册工具，这里返回结构化错误，
  // 模型据此改走别的路径（而不是收到一个 TypeError 打断整轮）。
  function resolve(args = {}) {
    if (!ctx || !ctx.projectId) {
      return { error: fail('NO_PROJECT_CONTEXT', '当前对话未绑定项目空间，工件工具不可用') };
    }
    const claimed = String(args.project_id || args.projectId || '').trim();
    if (claimed && claimed !== ctx.projectId) {
      return { error: fail('PROJECT_FORBIDDEN', `project_id 与当前会话绑定的项目不一致：${claimed}`) };
    }
    const store = typeof getArtifactStore === 'function' ? getArtifactStore() : null;
    if (!store) return { error: fail('STORE_UNAVAILABLE', '工件库不可用') };
    return { store };
  }

  // 工件解析：上下文指定 artifactId 优先，否则取该项目的主工件；归属必须与上下文项目一致。
  function resolveArtifact(store, args = {}) {
    const wanted = pickArtifactId(args) || String(ctx.artifactId || '').trim();
    let art = wanted ? store.getArtifact(wanted) : null;
    if (!art) art = (store.listArtifacts(ctx.projectId) || [])[0] || null;
    if (!art) return { error: fail('NOT_FOUND', '当前项目还没有工件；请先在项目里创建文档工件') };
    if (art.projectId !== ctx.projectId) {
      return { error: fail('PROJECT_FORBIDDEN', `工件不属于当前项目：${art.artifactId}`) };
    }
    return { art };
  }

  // patch 的审批闸：分级/摘要/可补偿性由 approval.js 单一事实来源决定（artifact_patch_section = L2）。
  // V01 纪律：审批档与对话 id 以**宿主绑定值**为准（ad.approvalMode / ad.conversationId），
  // 模型参数里的同名字段只作为无宿主绑定时的回落，不可用来放宽审批。
  async function gatePatch(args) {
    const approvalMode = String(ad.approvalMode || args.approvalMode || 'on-request');
    const conversationId = String(ad.conversationId || args.conversationId || '');
    const verdict = approval.needsApproval({
      tool: 'artifact_patch_section',
      args,
      approvalMode,
      conversationId,
      alwaysRules: typeof ad.getAlwaysRules === 'function' ? ad.getAlwaysRules() : [],
      conversationRules: Array.isArray(ad.conversationRules) ? ad.conversationRules : [],
    });
    if (!verdict.need) return null;
    if (typeof ad.requestApproval !== 'function') {
      // fail-closed：需要审批却没有审批通道时不得放行（与无人值守通道同纪律）
      return fail('APPROVAL_UNAVAILABLE', '审批通道不可用：本次工件写入需要用户确认');
    }
    const decision = await ad.requestApproval('artifact_patch_section', args);
    if (decision === 'deny') return { ok: false, denied: true, error: '用户拒绝执行' };
    if (typeof ad.applyApprovalDecision === 'function') {
      ad.applyApprovalDecision(decision, 'artifact_patch_section', args, conversationId);
    }
    return null;
  }

  // ── artifact_index ──
  function artifactIndex(args = {}) {
    const { store, error } = resolve(args);
    if (error) return error;
    const { art, error: artErr } = resolveArtifact(store, args);
    if (artErr) return artErr;
    let ix = null;
    try {
      ix = store.getIndex({ artifactId: art.artifactId, recentLimit: INDEX_RECENT_LIMIT });
    } catch (e) {
      return fromArtifactError(e);
    }
    return { ok: true, ...fitIndex(ix) };
  }

  // ── artifact_get_section ──
  function artifactGetSection(args = {}) {
    const { store, error } = resolve(args);
    if (error) return error;
    const { art, error: artErr } = resolveArtifact(store, args);
    if (artErr) return artErr;
    try {
      const r = store.getSection({
        artifactId: art.artifactId,
        sectionKey: args.section_key || args.sectionKey,
        version: args.version,
        offset: args.offset,
        maxChars: args.max_chars || args.maxChars,
      });
      // 读取侧只回本次片段；truncated/nextOffset 由 store 按字符数计算，模型据此翻页
      return { ok: true, ...r };
    } catch (e) {
      return fromArtifactError(e);
    }
  }

  // ── artifact_get_diff ──
  function artifactGetDiff(args = {}) {
    const { store, error } = resolve(args);
    if (error) return error;
    const { art, error: artErr } = resolveArtifact(store, args);
    if (artErr) return artErr;
    try {
      const r = store.getDiff({
        artifactId: art.artifactId,
        fromVersion: args.from_version || args.fromVersion,
        toVersion: args.to_version || args.toVersion,
        sectionKey: args.section_key || args.sectionKey,
      });
      return { ok: true, ...r };
    } catch (e) {
      return fromArtifactError(e);
    }
  }

  // ── artifact_patch_section ──
  async function artifactPatchSection(args = {}) {
    const { store, error } = resolve(args);
    if (error) return error;
    const { art, error: artErr } = resolveArtifact(store, args);
    if (artErr) return artErr;
    const sectionKey = String(args.section_key || args.sectionKey || '').trim();
    if (!sectionKey) return fail('INVALID_SECTION_KEY', 'section_key 必填');
    const baseVersion = String(args.base_version || args.baseVersion || '').trim();
    if (!baseVersion) {
      // 乐观锁是硬要求：没有 base_version 的写入等于「无条件覆盖别人刚写的内容」
      return fail('BASE_VERSION_REQUIRED', '必须提供 base_version（先 artifact_index 取当前版本）');
    }
    const denied = await gatePatch(args);
    if (denied) return denied;
    let r = null;
    try {
      r = store.patchSection({
        artifactId: art.artifactId,
        sectionKey,
        content: args.content == null ? '' : args.content,
        baseVersion,
        changeSummary: args.change_summary || args.changeSummary,
        // 作者身份取自宿主上下文，模型不可伪造
        authorMemberId: (ctx && ctx.memberId) || 'user',
        runId: (ctx && ctx.runId) || null,
      });
    } catch (e) {
      return fromArtifactError(e);
    }
    // §9.2 第 6 条：patch 成功后由**宿主**写一条 artifact_ref 事件（不是模型自觉）。
    // 只在成员任务（有团队总线）时写；交互式会话没有总线，不写。
    if (ctx && ctx.teamId && ctx.runId && typeof postMessage === 'function') {
      const summary = `更新工件章节 ${sectionKey} → ${r.version}（${r.chars} 字符）`
        + (args.change_summary || args.changeSummary ? `：${String(args.change_summary || args.changeSummary).slice(0, 120)}` : '');
      try {
        postMessage({
          teamId: ctx.teamId,
          runId: ctx.runId,
          fromMemberId: ctx.memberId || null,
          toMemberId: null,
          kind: 'artifact_ref',
          summary,
          payload: { artifactId: art.artifactId, sectionKey, version: r.version, chars: r.chars },
          refs: [`artifact:${art.artifactId}#${sectionKey}@${r.version}`],
        });
      } catch (e) {
        // 总线写入失败不回滚已提交的工件版本（版本已落库、可读），只是少一条广播
        console.warn('[artifact] artifact_ref 广播失败（不影响已提交版本）:', e.message);
      }
    }
    // 返回体刻意不含正文（§9.1）：只给版本与字数，模型要复核请再调 get_section
    return { ok: true, artifactId: art.artifactId, sectionKey, version: r.version, chars: r.chars, section: r.section };
  }

  return { artifactIndex, artifactGetSection, artifactPatchSection, artifactGetDiff };
}

module.exports = { createArtifactToolHandlers, INDEX_CHAR_BUDGET, fitIndex };

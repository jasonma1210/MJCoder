// main/tools/artifactWriteGate.js
// 「本机产物写闸」——所有「模型生成一个真实文件落到磁盘」的原生工具共用同一条写路径纪律。
//
// 为什么抽成独立模块（2026-10-19）：
//   本函数原为 main/docTools.js 的模块私有函数（doc_create / xlsx_create / pptx_create / pdf_generate 四工具用）。
//   G-latex 的原生编译工具（latex_compile）同样要往项目里落 PDF 产物，若它自己再写一份
//   「只读能力档 / 受保护路径 / 白名单根 / 审批分级」判定，就是**第二份 policy 副本**——
//   本项目历史上的多次事故（dangerousPatterns 手抄两份、审批档位双实现）都源于这种副本漂移，
//   因此这里直接抽出单一实现，两个消费方共用，改规则只改这一处。
//
// 判定顺序（与抽出前逐字节一致，不得调整）：
//   ① 只读文件能力档 → 直接拒绝（fail-closed，不提供单次放行）；
//   ② 受保护路径（.git / .mjcode）→ 无审批放行口，直接拒绝；
//   ③ 白名单外（非 cwd/userData/tmp）→ 强制弹一次审批，且批准不沉淀规则；
//   ④ 白名单内 → 走审批中心标准判定（产物类工具统一登记为 L2）。
//
// deps 由调用方（initDocTools / initLatexTools）注入：requestApproval / applyApprovalDecision /
// getAlwaysRules / conversationRules / getGovernance / userDataDir —— 保持本模块零 Electron 依赖，可单测。
'use strict';

const approval = require('../approval');
const writeGuard = require('../writeGuard');
const { audit } = require('../audit/auditLog');

/**
 * @param {object} deps 宿主注入依赖（见文件头）
 * @param {string} toolKey 审批表 key（与引擎侧工具名一致）
 * @param {object} args 工具参数（含 cwd / approvalMode / conversationId / requireApproval）
 * @param {string} absPath 已解析出的绝对输出路径
 * @returns {Promise<{ok:false, error:string, denied?:boolean, blocked?:boolean}|{ok:true, asked:boolean}>}
 */
async function gateArtifactWrite(deps, toolKey, args, absPath) {
  const { approvalMode = 'on-request', conversationId, requireApproval = true } = args || {};
  const cwd = String(args?.cwd || '').trim() || process.cwd();

  // ① 只读文件能力档（判定单一事实来源：writeGuard.isReadonlyFs，与 exec.js 写工具闸口共用）
  if (deps.getGovernance && writeGuard.isReadonlyFs(deps.getGovernance())) {
    audit(toolKey, absPath, '只读文件能力档拒绝写入', 'blocked');
    return { ok: false, blocked: true, readOnly: true, error: '当前为「只读文件能力」档，已拒绝生成文档（可在「本机服务 → 能力降级」切换为读写）。' };
  }

  // ② 受保护路径：即使位于项目目录内也禁止写入，且不接受审批放行
  const protectedPaths = writeGuard.protectedPathsFor(cwd);
  const hit = writeGuard.firstProtectedTarget([absPath], protectedPaths, cwd);
  if (hit) {
    audit(toolKey, absPath, `受保护路径写入被拦截：${hit}`, 'blocked');
    return { ok: false, blocked: true, protectedPath: true, error: `输出目标位于受保护路径内：${hit}。该路径受保护以防止篡改 git hooks / 应用配置，不接受审批放行。` };
  }

  // ③ 白名单根判定
  const roots = writeGuard.allowedWriteRoots({ cwd, userDataDir: deps.userDataDir });
  const outside = writeGuard.firstOutsideTarget([absPath], roots, cwd);
  if (outside) {
    if (!requireApproval || approvalMode === 'never') {
      audit(toolKey, absPath, `白名单外写入被拦截：${outside}`, 'blocked');
      return { ok: false, blocked: true, outsideWhitelist: true, error: `输出目标超出允许范围（仅限项目目录 / 应用数据 / 系统临时目录）：${outside}` };
    }
    const decision = await deps.requestApproval(toolKey, { ...args, path: absPath });
    if (decision === 'deny') {
      audit(toolKey, absPath, `白名单外写入被拒绝：${outside}`, 'denied');
      return { ok: false, denied: true, error: '用户拒绝执行' };
    }
    // 白名单外的批准仅本次有效（不调用 applyApprovalDecision，规则不落地）
    return { ok: true, asked: true };
  }

  // ④ 白名单内 → 审批中心标准判定
  const verdict = approval.needsApproval({
    tool: toolKey, args: { ...args, path: absPath }, approvalMode, conversationId,
    alwaysRules: deps.getAlwaysRules(), conversationRules: deps.conversationRules,
  });
  if (verdict.need) {
    const decision = await deps.requestApproval(toolKey, { ...args, path: absPath });
    if (decision === 'deny') {
      audit(toolKey, absPath, '用户拒绝', 'denied');
      return { ok: false, denied: true, error: '用户拒绝执行' };
    }
    deps.applyApprovalDecision(decision, toolKey, { ...args, path: absPath }, conversationId);
  }
  return { ok: true, asked: !!verdict.need };
}

module.exports = { gateArtifactWrite };

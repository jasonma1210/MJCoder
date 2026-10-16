// main/approvalPolicy.js
// 审批档与沙箱策略的「取更严者」纪律——全项目唯一事实来源。
//
// 为什么独立成文件（2026-10-16）：这两个函数原为 agentRunner.js 的模块私有函数。
// Worker 路径（workerPool.js 启动的子任务）需要同一条纪律，但它拿不到，于是
// 硬编码 approvalMode:'auto-safe' —— 结果是用户选「全部询问」时子任务仍自动放行，
// 即**产品对用户的设置撒谎**。
//
// 为什么不直接从 workerPool require agentRunner：
//   · 语义上「任务池」依赖「任务运行器」方向别扭；
//   · 本项目已有同类先例（dangerousPatterns.js 同样是因规则被手抄成两份副本而抽出），
//     沿用该惯例可保持一致性；
//   · 纯函数、零依赖，两个消费方都能安全引用。

// 审批严格序（弹卡越多越严）：never < auto-safe < on-request < always
const APPROVAL_ORDER = { never: 0, 'auto-safe': 1, 'on-request': 2, always: 3 };
// 沙箱严格序（权限越小越严）：read-only < workspace-write < full-access
const SANDBOX_ORDER = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 };

const DEFAULT_APPROVAL = 'on-request';
const DEFAULT_SANDBOX = 'workspace-write';

/**
 * V12（2026-10-16）：枚举归一化——未知/非法值一律收敛到默认档。
 * 此前 stricterApproval('INVALID','auto-safe') 会原样返回 'INVALID'，
 * 下游 needsApproval 虽 fail-closed，但 UI/审计/快照会记录一个不存在的档位，
 * 且非法值可能沿途被当成「比默认更严」的未知量参与比较。先归一再比较。
 */
function normalizeApprovalMode(mode) {
  return APPROVAL_ORDER[mode] != null ? mode : DEFAULT_APPROVAL;
}

function normalizeSandboxPolicy(policy) {
  return SANDBOX_ORDER[policy] != null ? policy : DEFAULT_SANDBOX;
}

/**
 * 取用户档与角色档中更严格者。角色只能收紧、绝不能放宽。
 * 非法值按默认档参与比较（不放宽权限）；返回值保证是合法枚举。
 * @param {string} userMode 用户设置档
 * @param {string} [roleMode] 角色声明档（缺省表示不额外约束）
 * @returns {string}
 */
function stricterApproval(userMode, roleMode) {
  const a = normalizeApprovalMode(userMode);
  if (!roleMode) return a;
  const b = normalizeApprovalMode(roleMode);
  return APPROVAL_ORDER[b] > APPROVAL_ORDER[a] ? b : a;
}

/**
 * 取用户策略与角色策略中更严格者（权限更小者）。
 * 非法值按默认策略参与比较；返回值保证是合法枚举。
 * @param {string} userPolicy
 * @param {string} [rolePolicy]
 * @returns {string}
 */
function stricterSandbox(userPolicy, rolePolicy) {
  const a = normalizeSandboxPolicy(userPolicy);
  if (!rolePolicy) return a;
  const b = normalizeSandboxPolicy(rolePolicy);
  return SANDBOX_ORDER[b] < SANDBOX_ORDER[a] ? b : a;
}

module.exports = {
  stricterApproval,
  stricterSandbox,
  normalizeApprovalMode,
  normalizeSandboxPolicy,
  APPROVAL_ORDER,
  SANDBOX_ORDER,
  DEFAULT_APPROVAL,
  DEFAULT_SANDBOX,
};
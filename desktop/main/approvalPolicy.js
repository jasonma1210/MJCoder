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

/**
 * V04：编排建组时固化的「宿主治理快照」——审批档由调用方取用户当前设置，沙箱按宿主推导
 * （有项目目录 workspace-write / 无目录 read-only），一律不接受模型参数（max_agents 等治理
 * 字段已被忽略）；快照随组持久化，Worker 执行时直接读。
 *
 * 为什么放在这里而不是 main.js / ipc/tasks.js：同一纪律不能有两份实现。head 里记录的事故
 * 正是「Worker 路径拿不到 → 就地硬编码 auto-safe → 产品对用户设置撒谎」，与本函数要防的
 * 是同一类漂移。审批档由调用方传入（本文件保持纯函数、零依赖，避免 require agentRunner 成环）。
 *
 * 边界说明（别过度声称）：本函数是「**编排建组快照**」的唯一来源，不是「cwd→沙箱档」这条推导的
 * 唯一出处——`runScheduledAgentTask`（main.js）、`toolShell`/`runWriteTool`（tools/exec.js）、
 * `workerPool` 里各有**逐次运行的默认值**回落（角色不同：那些是「本次执行的默认档」，本函数是
 * 「建组时固化、随组持久化」的快照）。要收敛成一处公用辅助函数是可以做的，但会牵动四条安全敏感
 * 路径，需单独评估，别顺手改。
 *
 * X14 移动事故（2026-10-18）：`tasks:*` 搬进 ipc/tasks.js 时本函数跟着搬走，却漏改
 * main.js 里 `toolOrchestrateTask` 的调用点 → 模型一调 orchestrate_task 就 ReferenceError
 * （`node --check` 查不出跨作用域引用，只有 eslint no-undef / 真跑用例能抓）。
 * 现在两处调用点各自 import 本文件：main.js 传 `agentRunner.getCurrentApprovalMode()`，
 * ipc/tasks.js 传 `deps.getApprovalMode()`。
 *
 * @param {string} cwd 工作目录（决定沙箱档）
 * @param {string} approvalMode 调用方取到的用户当前审批档
 * @returns {{approvalMode: string, sandboxPolicy: string}}
 */
function hostPolicySnapshot(cwd, approvalMode) {
  return {
    // 归一化：非法/未知档位收敛到默认档，绝不让一个不存在的档位随组快照落盘（见 V12 注释）
    approvalMode: normalizeApprovalMode(approvalMode),
    sandboxPolicy: cwd ? 'workspace-write' : 'read-only',
  };
}

module.exports = {
  hostPolicySnapshot,
  stricterApproval,
  stricterSandbox,
  normalizeApprovalMode,
  normalizeSandboxPolicy,
  APPROVAL_ORDER,
  SANDBOX_ORDER,
  DEFAULT_APPROVAL,
  DEFAULT_SANDBOX,
};
// shared/roleClamp.mjs
// 角色模板（数字员工）审批档/沙箱策略的「取更严格者」纪律——**渲染层可静态引用**的那一份。
//
// ⚠️ 定位（先看这条再看代码）：本文件是 main/approvalPolicy.js 的**镜像**，不是独立实现。
//   「唯一事实源」仍是 main/approvalPolicy.js；本文件存在的唯一理由是它能被渲染层静态 import。
//   两份内容必须逐值一致（含归一化行为与非法值处置），不允许在此「顺手优化」其中一侧。
//
// 为什么需要本文件（F-020，第七轮审查）：
//   `agent:run` 有两条通道：主进程通道（main/agentRunner.js）与进程内回退通道
//   （renderer/src/lib/agent.js 的 runAgentInProcess）。主通道在 378-381 行对 rolePreset
//   做了「角色只能收紧、绝不能放宽」的钳制，回退通道此前**一处钳制都没有** ——
//   同一份 rolePreset 在两条通道下生效程度不同，即「同一个产品，两个行为」。
//   回退路径不是死代码：旧版 preload、纯 Node 测试环境（agent-engine.test.mjs 等）都走它。
//
// 为什么不能收敛成单源（已评估并否决，别再试一遍）：
//   1) 模块制式互斥。main/ 是 CJS（Electron 主进程），renderer/ 是 ESM（Vite 打包）：
//      `.mjs` 无法被 CJS **同步** require；CJS 的 `module.exports` 也无法在浏览器端执行。
//      钳制必须在组装 engineParams 的同一个同步栈里完成，异步加载（dynamic import）不可用。
//   2) 反向改 `.cjs` 的代价更大：approvalPolicy.js 现有 **5 个消费方** —— main/agentRunner.js、
//      main/workerPool.js、main/main.js、main/approvalSettings.js、main/ipc/tasks.js ——
//      全部要改引入方式，且牵动审批/沙箱这条安全敏感路径，风险远大于镜像 + 门禁的收益。
//   ⇒ 各留一份实现，用**逐值全矩阵对账**代替「物理同一份文件」：
//   test/agent-fallback-clamp.test.mjs 的 C1-C4 把本文件与 main/approvalPolicy.js 在
//   approval 5×5 + sandbox 3×3 全组合（含未知值/空值/undefined/null）上逐值比对。
//   （本项目既有同类先例：dangerousPatterns.js、mcpNameCodec.mjs 都因规则被手抄成两份而抽出；
//   此处受制于模块制式无法抽成一份，改用门禁锁定。）
//
// 改动纪律（违反任一条，C1-C4 会立刻变红）：
//   a. 改本文件的任何函数/常量 → **必须同批改** main/approvalPolicy.js 的对应项，反之亦然；
//   b. 新增档位/改严格序 → 两侧同改；只改一侧会让「哪份更严」两条通道各说各话；
//   c. 想改「非法值处置」先改门禁预期（A6/C1 已锁死「未知值按默认档参与比较、不放大权限」）；
//   d. 本文件必须保持纯函数、零依赖、零 Node 内置（渲染层打包 + 纯 Node 测试都要能直接加载）。
//
// 纯函数、零依赖、零 Node 内置 —— 渲染层（浏览器）与测试（Node）都能直接用。

// 审批严格序（弹卡越多越严）：never < auto-safe < on-request < always
export const APPROVAL_ORDER = { never: 0, 'auto-safe': 1, 'on-request': 2, always: 3 };
// 沙箱严格序（权限越小越严）：read-only < workspace-write < full-access
export const SANDBOX_ORDER = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 };

export const DEFAULT_APPROVAL = 'on-request';
export const DEFAULT_SANDBOX = 'workspace-write';

/**
 * 枚举归一化——未知/非法值一律收敛到默认档。
 * 与 main/approvalPolicy.js 的 normalizeApprovalMode 逐值一致（见文件头对账说明）。
 * 不做归一的话，非法值可能沿途被当成「比默认更严」的未知量参与比较，
 * 且 UI/审计/快照会记录一个不存在的档位。
 */
export function normalizeApprovalMode(mode) {
  return APPROVAL_ORDER[mode] != null ? mode : DEFAULT_APPROVAL;
}

export function normalizeSandboxPolicy(policy) {
  return SANDBOX_ORDER[policy] != null ? policy : DEFAULT_SANDBOX;
}

/**
 * 取用户档与角色档中更严格者。角色只能收紧、绝不能放宽。
 * 非法值按默认档参与比较（不放宽权限）；返回值保证是合法枚举。
 * @param {string} userMode 用户设置档
 * @param {string} [roleMode] 角色声明档（缺省表示不额外约束）
 * @returns {string}
 */
export function stricterApproval(userMode, roleMode) {
  const a = normalizeApprovalMode(userMode);
  if (!roleMode) return a;
  const b = normalizeApprovalMode(roleMode);
  return APPROVAL_ORDER[b] > APPROVAL_ORDER[a] ? b : a;
}

/**
 * 取用户策略与角色策略中更严格者（权限更小者）。
 * @param {string} userPolicy
 * @param {string} [rolePolicy]
 * @returns {string}
 */
export function stricterSandbox(userPolicy, rolePolicy) {
  const a = normalizeSandboxPolicy(userPolicy);
  if (!rolePolicy) return a;
  const b = normalizeSandboxPolicy(rolePolicy);
  return SANDBOX_ORDER[b] < SANDBOX_ORDER[a] ? b : a;
}

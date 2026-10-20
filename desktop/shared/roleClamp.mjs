// shared/roleClamp.mjs
// 角色模板（数字员工）审批档/沙箱策略的「取更严格者」纪律——**渲染层可静态引用**的 ESM 薄壳。
//
// ⚠️ 定位（先看这条再看代码）：本文件不自带任何策略值，值全部来自 **shared/rolePolicyData.json**；
//   它与 main/approvalPolicy.js（CJS 薄壳）读同一份数据，各自只留「读数据 + 查表 + 归一化」的逻辑。
//   两侧都**不允许在这里「顺手优化」**：要改档位/严格序/默认档 → 改 JSON；要在不改数据的前提下
//   改比较逻辑 → 两侧同批改，否则 test/role-clamp-parity.test.mjs 与
//   test/agent-fallback-clamp.test.mjs（64 组全矩阵对账）会立刻变红。
//
// 为什么需要本文件（F-020，第七轮审查）：
//   `agent:run` 有两条通道：主进程通道（main/agentRunner.js）与进程内回退通道
//   （renderer/src/lib/agent.js 的 runAgentInProcess）。主通道在 378-381 行对 rolePreset
//   做了「角色只能收紧、绝不能放宽」的钳制，回退通道此前**一处钳制都没有** ——
//   同一份 rolePreset 在两条通道下生效程度不同，即「同一个产品，两个行为」。
//   回退路径不是死代码：旧版 preload、纯 Node 测试环境（agent-engine.test.mjs 等）都走它。
//
// 收敛方案（D-13，本文件现在的形态）——**数据单源 + 双薄壳 + 一致性门禁**：
//   会漂移的值（档位集合、严格序、默认档）抽到唯一 JSON（shared/rolePolicyData.json）；
//   两侧只留薄壳。物理上仍是两个文件，但「值」只有一处，漂移从「靠自觉」变成「门禁挡住」：
//   test/role-clamp-parity.test.mjs 锁「JSON ↔ 左壳 ↔ 右壳 逐值相等」+「缺段即红」+ 变异自检，
//   test/agent-fallback-clamp.test.mjs 的 C1-C4 锁两壳在 approval 5×5 + sandbox 3×3 全组合
//   （含未知值/空值/undefined/null）上逐值相等。
//
// ── 历史附录：为什么**物理合并成同一个文件**这条路被否决（已评估，别再试一遍）──────────
//   1) 模块制式互斥。main/ 是 CJS（Electron 主进程），renderer/ 是 ESM（Vite 打包）：
//      `.mjs` 无法被 CJS **同步** require；CJS 的 `module.exports` 也无法在浏览器端执行。
//      钳制必须在组装 engineParams 的同一个同步栈里完成，异步加载（dynamic import）不可用。
//   2) 反向改 `.cjs` 的代价更大：approvalPolicy.js 现有 **5 个消费方** —— main/agentRunner.js、
//      main/workerPool.js、main/main.js、main/approvalSettings.js、main/ipc/tasks.js ——
//      全部要改引入方式，且牵动审批/沙箱这条安全敏感路径，风险远大于「单源 + 门禁」的收益。
//   3) 若硬推物理单源，最可能的落地是「渲染层异步加载失败 → 回退路径静默跳过钳制」，
//      那正好把 F-020（「同一个产品，两个行为」）原样复活 —— 这是本条被否决的决定性理由。
//   ⇒ 注意：上面否决的是「合成一个**文件**」，不是「合成一个**源**」。源已经合成（那份 JSON）。
//     历史里另一批同类收敛（dangerousPatterns.js、mcpNameCodec.mjs）能抽成单文件，是因为两侧
//     同制式；本纪律受模块制式所限只能到「单源」这一层，剩下靠门禁。
//
// 改动纪律（违反任一条，上面两道门禁会立刻变红）：
//   a. 改本文件的任何函数 → **必须同批改** main/approvalPolicy.js 的对应项，反之亦然；
//   b. 新增档位/改严格序 → 只改 JSON，**不要**再在本文件或 approvalPolicy.js 里写字面量；
//   c. 想改「非法值处置」先改门禁预期（A6/C1 已锁死「未知值按默认档参与比较、不放大权限」）；
//   d. 本文件必须保持纯函数、零依赖、零 Node 内置（渲染层打包 + 纯 Node 测试都要能直接加载）。
//      JSON import 是数据不是依赖，两侧/两种环境都支持（Node 侧需 `with { type: 'json' }`，
//      Vite 原生支持 JSON import，两者产出同一份值）。
//   e. 两壳导出函数集**有意不对称**：`hostPolicySnapshot` 只在 CJS 侧（main/approvalPolicy.js）。
//      渲染层回退通道只需要「取更严者」钳制，不需要「编排建组快照」——建组发生在主进程，快照随组
//      持久化后由 Worker 读。**不要**为了「对称」在 ESM 侧派生副本：那会把刚消掉的重复再造回来。
//      该非对称由 test/role-clamp-parity.test.mjs 的 B-5 断言锁死（断言 esmShell.hostPolicySnapshot
//      为 undefined），所以它不是「漏搬项」，是设计。

// 数据单源：档位集合 / 严格序 / 默认档的唯一出处。缺 approval 或 sandbox 段会立刻 TypeError
// （不允许兜底成空表——空表会让「未知值归一化」静默指向不存在的默认档）。
import DATA from './rolePolicyData.json' with { type: 'json' };

// 严格序：审批 never<auto-safe<on-request<always（弹卡越多越严），沙箱 read-only<workspace-write<full-access（权限越小越严）
// 浅拷贝：消费方改导出对象也污染不到共用的 JSON 模块实例。
export const APPROVAL_ORDER = { ...DATA.approval.order };
export const SANDBOX_ORDER = { ...DATA.sandbox.order };

export const DEFAULT_APPROVAL = DATA.approval.default;
export const DEFAULT_SANDBOX = DATA.sandbox.default;

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

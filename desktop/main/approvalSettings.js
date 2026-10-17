// 无人值守路径的审批/沙箱档来源（2026-10-17，修复 P1-1）。
//
// 问题：`agentRunner.getCurrentApprovalMode()` 返回的是**模块级「最后一次 startAgentRun 写入的值」**。
// 而审批档可以按会话覆盖（`useAgentRun.ts:527` 是 `thread.approval_mode || 设置`），
// 所以「最后一次交互 run 的档」≠「用户设置」。它却被四处无人值守路径共用：
//   · 编排组快照（main.js hostPolicySnapshot）
//   · 定时任务（scheduled 执行通道）
//   · CUA / 回放（IPC 入参钳制的第二参）
//   · Worker 兜底（workerPool deps.getApprovalMode）
// 后果：会话 A 设「每条都问」，在会话 B（「从不问」）发过消息后再回 A 发起编排，
//   组快照会记成「从不问」——比用户设置更松，且没有任何提示。
//
// 纪律：**交互 run 用 payload.approvalMode（会话级覆盖，属正确来源）；
//   无人值守用本文件的持久化设置**。两者不可互替。
//
// 设置落点：渲染层 `mj_approval_settings`（localStorage）在变更时同步一份到
//   `localStore.preferences['approval_settings']`，主进程由此读取。
//   这样即使本次进程内从未发生过交互（例如开机即到点触发定时任务），也能拿到用户的选择。
const APPROVAL_ORDER = { never: 0, 'auto-safe': 1, 'on-request': 2, always: 3 };
const SANDBOX_ORDER = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 };
const DEFAULT_APPROVAL = 'on-request';
const DEFAULT_SANDBOX = 'workspace-write';

let getLocalStore = () => null;

function initApprovalSettings(deps = {}) {
  // 只存 getter（localStore 在 whenReady 之后才有值），不要在 init 时取值
  getLocalStore = typeof deps.getLocalStore === 'function' ? deps.getLocalStore : () => null;
}

function readPersisted() {
  try {
    const store = getLocalStore();
    const v = store?.getPreference?.('approval_settings');
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    // 读设置失败不能反过来放宽权限：回落默认值（on-request / workspace-write）
    console.warn('[approvalSettings] 读取持久化设置失败，回落默认值:', e.message);
    return {};
  }
}

/** 用户在设置页选的审批档（无人值守路径的唯一正确来源） */
function getUserApprovalMode() {
  const v = readPersisted().approval_mode;
  return Object.prototype.hasOwnProperty.call(APPROVAL_ORDER, v) ? v : DEFAULT_APPROVAL;
}

/** 用户在设置页选的沙箱档（供无人值守路径与出参对照） */
function getUserSandboxPolicy() {
  const v = readPersisted().sandbox_policy;
  return Object.prototype.hasOwnProperty.call(SANDBOX_ORDER, v) ? v : DEFAULT_SANDBOX;
}

/**
 * 取「请求档 与 用户设置档」中更严者。无人值守路径的入参钳制统一走这里，
 * 避免各处再各自实现一遍顺序表（approvalPolicy.js 是唯一事实源）。
 * @param {string|undefined} requested 调用方/模型传入的档位（可能被注入成更松的档）
 * @param {(a: string, b: string) => string} stricterApproval approvalPolicy 的取更严者
 */
function clampWithSettings(requested, stricterApproval) {
  const user = getUserApprovalMode();
  const req = Object.prototype.hasOwnProperty.call(APPROVAL_ORDER, requested) ? requested : 'on-request';
  return typeof stricterApproval === 'function' ? stricterApproval(req, user) : user;
}

module.exports = {
  initApprovalSettings,
  getUserApprovalMode,
  getUserSandboxPolicy,
  clampWithSettings,
  DEFAULT_APPROVAL,
  DEFAULT_SANDBOX,
};

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
// P2-7 顺带清债：本文件原有一份与 approvalPolicy.js 完全相同的 APPROVAL_ORDER / SANDBOX_ORDER /
// 默认值副本（仓库里同一张表的第三份）。重复表的典型后果是「一边加了档位另一边不认识」→
// 静默回落默认档，用户设置看起来保存成功却没生效。现统一引用 approvalPolicy.js（单一事实来源），
// 本文件不再自建顺序表。
const {
  APPROVAL_ORDER, SANDBOX_ORDER, DEFAULT_APPROVAL, DEFAULT_SANDBOX,
} = require('./approvalPolicy');
// P2-7：执行后告知的出口注入（本文件是审批域的初始化入口，sink 在这里接线最合适）
const approval = require('./approval');

let getLocalStore = () => null;

function initApprovalSettings(deps = {}) {
  // 只存 getter（localStore 在 whenReady 之后才有值），不要在 init 时取值
  getLocalStore = typeof deps.getLocalStore === 'function' ? deps.getLocalStore : () => null;
  // P2-7：把「执行后告知」的通知出口接到宿主事件通道（emitTaskEvent，既有通道，不新开 IPC）。
  // 只在**显式注入** emit 时才接管 sink：这样即使 init 顺序变化（例如先由别处接线、后调本函数），
  // 也不会把已接好的出口清成 null。未注入时 approval.js 会落 warn 说明「未接线」。
  if (typeof deps.emit === 'function') {
    approval.setNoticeSink((notice) => deps.emit({ ...notice, ts: Date.now() }));
  }
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
 * P2-7：用户是否开启「执行后告知」（正交布尔，缺省 **false**）。
 *
 * 为什么是独立布尔而不是第五档：档位枚举是跨 5 处契约（contract/policy/settings/ecosystem/UI），
 * 加档漏改任何一处都会导致运行期 `agent:run` 被契约拒绝；而「执行后告知」本质是
 * 「执行完告诉我一声」，与「执行前问不问」正交，可叠加在任何档位上（含 always）。
 * 详见 main/approval.js 文件头的偏离说明。
 *
 * 默认 false：为 false 时全链路不产生任何通知，行为与改造前一致（零破坏）。
 */
function getUserApprovalNotice() {
  const v = readPersisted();
  // 只认严格布尔 true：字符串 'true'/'1' 一律视为关闭（避免持久化侧类型漂移放大成隐私/性能问题）
  return v && v.approval_notice === true;
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
  // P2-7：执行后告知（正交布尔偏好）
  getUserApprovalNotice,
  clampWithSettings,
  DEFAULT_APPROVAL,
  DEFAULT_SANDBOX,
};

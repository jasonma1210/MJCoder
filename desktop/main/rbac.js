'use strict';
// P1-7a：最小角色-动作判定（纯函数、零依赖、可单测）
//
// ⚠️ 先读这段：**这还不是一套权限系统**。
//   本项目是单用户桌面应用——没有登录态、没有租户、没有多账号，因此「当前角色」的来源
//   被固定为 'admin'（见 main/ipc/ecosystem.js 的 getRole，那里是唯一的替换点）。
//   本模块存在的意义是把「谁能做什么」的判断从各写通道里抽出来**单点化**：
//     · 授权语义现在就固定，不再散落在每个 handler 的 if 里；
//     · 将来接入真实身份来源时，只改 getRole() 一处，所有写通道立即受控。
//   请不要因为「现在恒为 admin、恒 true」就把调用点删掉——那会把未来的接入点一起删掉。
//
// 硬保证（fail-closed）：未知角色、未知动作、非法入参一律**拒绝**，绝不默认放行。
//   这条比「现在能干什么」重要得多：权限判定的默认方向一旦反了，接入多用户当天就是提权漏洞。

const ROLES = Object.freeze({
  // 只读：能看员工、不能改/不能跑
  viewer: Object.freeze(['employee:read']),
  // 日常使用：能建/改员工并跑起来
  operator: Object.freeze(['employee:read', 'employee:write', 'employee:run']),
  // 管理员：通配（本机默认角色）
  admin: Object.freeze(['*']),
});

/**
 * 角色是否可执行某动作。
 * @param {string} role   角色名（必须是 ROLES 的键）
 * @param {string} action 动作名，如 'employee:write'
 * @returns {boolean} 未知角色/未知动作/非法入参 → false（fail-closed）
 */
function can(role, action) {
  if (typeof role !== 'string' || typeof action !== 'string') return false;
  if (!action) return false;
  const actions = ROLES[role];
  if (!actions) return false; // 未知角色：拒绝，绝不「默认最宽松」
  if (actions.includes('*')) return true; // admin 通配
  return actions.includes(action);
}

/**
 * 动作不足时抛出可诊断错误（错误信息含动作与当前角色，便于审计与 UI 提示）。
 * @returns {true}
 */
function assertCan(role, action) {
  if (can(role, action)) return true;
  const err = new Error(`权限不足：角色 ${JSON.stringify(role)} 无权执行 ${JSON.stringify(action)}`);
  err.name = 'RbacError';
  err.code = 'FORBIDDEN';
  err.role = role;
  err.action = action;
  throw err;
}

module.exports = { ROLES, can, assertCan };

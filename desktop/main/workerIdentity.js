// Worker 身份段（2026-10-22 产品边界 R-16 / 第九轮 X-2）——
// 从 workerPool.js 抽出：该文件 798/800 行（800 软档只减不增），按项目纪律「先拆再合入」。
// 语义与实现**原样迁移**（原有两条 system 分支逐字保留），不在拆分中夹带行为变更。
//
// 背景（产品边界专题）：
//   Worker 通道的首条 system 消息此前是同一句通用串（「你是 MJ Coder 的并行任务
//   Worker……」），军团成员的人格靠 applyMemberRuntimeConfig 事后补 rolePreset——
//   结果是「未配人格的成员」与「纯自动编排的公共 Worker」在 system 首条完全同形，
//   用户与模型在第一句话里看不出「这个人是谁」。本模块补的正是这一句身份。
//
// 两条硬约束（零回归判据）：
//   ① **非军团路径字节不变**：未认领 / 无名册 / 反查异常 ⇒ 身份段为空串 ⇒ 返回的
//      system 与迁移前逐字节相同（守护测试 worker-identity.test.mjs 锁此条）；
//   ② 反查口径与 applyMemberRuntimeConfig **同源**：都走 deps.resolveTeamRoster(group)
//      → 按 ownerMemberId 找名册；失败只 warn 后按公共 Worker 身份运行，绝不失败整轮。
'use strict';

/** 成员名截断上限（system 消息体量保护，与 rolePreset.systemPrompt 的 12000 上限同理取小值）。 */
const MEMBER_NAME_MAX = 64;

/**
 * 按认领成员反查名册成员；未认领 / 无名册 / 反查异常 → null（= 公共 Worker 身份）。
 *
 * @param {object} ctx { group, task, deps }
 * @returns {object|null} 名册成员（run 快照或实时名册中的条目）
 */
function resolveOwnerMember({ group, task, deps = {} } = {}) {
  const memberId = task?.ownerMemberId || '';
  if (!memberId) return null;
  let roster = null;
  try {
    roster = typeof deps.resolveTeamRoster === 'function' ? deps.resolveTeamRoster(group) : null;
  } catch (e) {
    console.warn('[workerIdentity] 成员反查失败（按公共 Worker 身份运行）:', e.message);
    return null;
  }
  if (!Array.isArray(roster)) return null;
  return roster.find((m) => m && m.id === memberId) || null;
}

/**
 * 成员身份后缀：只有名册成员**带名字**才返回非空。
 * 无名（草稿成员 / 坏数据）⇒ 空串 ⇒ 通用串字节不变（不发明身份）。
 *
 * @param {object|null} member 名册成员
 * @returns {string} 身份段（不含前导换行）或空串
 */
function memberIdentitySuffix(member) {
  const name = String(member?.name || '').trim().slice(0, MEMBER_NAME_MAX);
  if (!name) return '';
  return `你是「${name}」——本军团的一名成员，以上是分配给你的子任务。`;
}

/**
 * 组装 Worker 首条 system 消息。
 * 两个原有分支（对话型 / 任务型）逐字保留；仅当反查到有名成员时追加身份段。
 *
 * @param {object} opts { chatOnly: boolean, ownerMember: object|null }
 * @returns {string} 完整 system 消息
 */
function buildWorkerSystemPrompt({ chatOnly, ownerMember } = {}) {
  const identity = memberIdentitySuffix(ownerMember);
  const base = chatOnly
    ? '你是 MJ Coder 的团队成员。本轮只需在对话中直接说一句话：按用户消息里的格式原样输出一行文本；不得调用任何工具、不得读写文件、不得执行命令、不得解释或寒暄。'
    : '你是 MJ Coder 的并行任务 Worker：只完成分配给你的子任务，产出精炼、可执行的结论。'
      + '完成前必须自测验证：能运行测试/命令验证的就实际运行，写完的文件就回读确认关键内容存在；验证不过要修复后再收尾。'
      + '结束时用一段「summary」总结做了什么、验证结果与关键产物（文件路径等）；不要反问，不要输出无关寒暄。';
  return identity ? `${base}\n\n${identity}` : base;
}

module.exports = { resolveOwnerMember, memberIdentitySuffix, buildWorkerSystemPrompt, MEMBER_NAME_MAX };

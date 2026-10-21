// run 级编制快照（从 ipc/teams.js 抽出，2026-10-21）
//
// 抽出的直接原因：`ipc/teams.js` 已达 804 行、越过 800 行软档，而 B-02 需要在该文件的
// 派活路径上加 `runMeta.budget`。按纪律「先拆再合入、白名单只减不增」，把一块**纯函数**
// 搬出来，而不是加白名单或删注释充数。
//
// 语义与抽走前**逐字等价**（搬家，不是改造）：
//   M5 / T5-9（§9.1）：run 级编制快照。只保留运行期真正需要的字段
//   （id / 角色 / 工具 / 模型 / 提示词 / 审批与沙箱档 / 技能），随 dag_json 一次落库；
//   运行期读快照而非实时名册 ⇒ 中途改配置只影响下一个 run。
//   名册来自本次被选中的成员（含统筹），因此「本次谁参与」也被快照固定。
//
// 为什么必须是纯函数：它同时被派活路径（写快照）与运行期（读快照）依赖，
// 任何隐式状态都会让「同一次运行可复现、可审计」这条保证失效。

'use strict';

/**
 * @param {Array<object>|null} members 本次被选中的成员（含统筹）
 * @returns {Array<object>} 快照数组（无 id 的成员被过滤掉）
 */
function snapshotRoster(members) {
  return (Array.isArray(members) ? members : [])
    .filter((m) => m && m.id)
    .map((m) => ({
      id: String(m.id),
      name: String(m.name || m.id),
      avatar: m.avatar || null,
      roleKind: m.roleKind === 'lead' ? 'lead' : 'member',
      systemPrompt: String(m.systemPrompt || ''),
      toolNames: Array.isArray(m.toolNames) ? [...m.toolNames] : [],
      allowMcp: m.allowMcp === true,
      model: m.model || null,
      approvalMode: m.approvalMode || null,
      sandboxPolicy: m.sandboxPolicy || null,
      skillNames: Array.isArray(m.skillNames) ? [...m.skillNames] : [],
      enabled: m.enabled !== false,
    }));
}

module.exports = { snapshotRoster };

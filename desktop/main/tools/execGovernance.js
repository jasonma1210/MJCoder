// P0-5：直连 IPC 的治理参数强制覆写——tool:shell / tool:write* / tool:git* 的载荷
// 治理字段不再可信（被注入的渲染层脚本 / 有缺陷的调用方可带 requireApproval=false +
// sandboxPolicy='full-access' 绕过审批与沙箱直跑）。模型路径已由 agent-core 剥离
// GOVERNANCE_FIELDS + 宿主绑定覆盖（V01）；本模块补齐直连 IPC 这条腿：
//   · requireApproval 恒 true：直连调用必须过审批卡（交互式用户当场决策，UX 不变）；
//   · sandboxPolicy 钳制到安全档集合：full-access（不做隔离）只能经会话运行链路的
//     宿主绑定进入（那里有 UI 二次确认，P1-3），直连 IPC 一律按 cwd 推导：
//     有 cwd → workspace-write；无 cwd → read-only（与 approvalPolicy.sandboxTierForCwd 同语义）。
//     2026-10-21：此前无 cwd 也回落 workspace-write，导致「无项目目录也能写」——
//     macOS 27 沙箱修复后该越权路径被 tools-cwd 门禁抓出。
const ALLOWED_SANDBOX = new Set(['read-only', 'workspace-write']);

function ipcGovernance(payload = {}) {
  return {
    ...payload,
    requireApproval: true,
    sandboxPolicy: ALLOWED_SANDBOX.has(payload.sandboxPolicy)
      ? payload.sandboxPolicy
      : (payload.cwd ? 'workspace-write' : 'read-only'),
  };
}

module.exports = { ipcGovernance };

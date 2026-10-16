// 审批/沙箱档位唯一常量源（A10 / 报告第 8 节）
// ComposerControls 与 SettingsModal 共用，禁止再各自维护值域。
// 历史值域冲突：Composer 曾用 auto / always-ask，设置页曾用 auto-safe / always —— 读取时一律迁移。
// T3-2 补漏（2026-10-16）：只存 i18n key，渲染时经 t()/tGlobal() 解析——
// 顶层常量持有中文会让英文界面显示中文（真机反馈：设置页沙箱/审批区块全中文）。
export const APPROVAL_MODES = [
  { id: 'on-request', nameKey: 'approval.onRequest', descKey: 'approval.onRequestDesc' },
  { id: 'auto-safe', nameKey: 'approval.autoSafe', descKey: 'approval.autoSafeDesc' },
  { id: 'always', nameKey: 'approval.always', descKey: 'approval.alwaysDesc' },
  { id: 'never', nameKey: 'approval.never', descKey: 'approval.neverDesc' },
];

export const SANDBOX_MODES = [
  { id: 'read-only', nameKey: 'approval.readOnly', descKey: 'approval.readOnlyDesc' },
  { id: 'workspace-write', nameKey: 'approval.workspaceWrite', descKey: 'approval.workspaceWriteDesc' },
  { id: 'full-access', nameKey: 'approval.fullAccess', descKey: 'approval.fullAccessDesc' },
];

// 遗留值迁移：auto → auto-safe、always-ask → always（读取时映射，写入只写新值）
export function migrateApprovalMode(value) {
  if (value === 'auto') return 'auto-safe';
  if (value === 'always-ask') return 'always';
  return value || 'on-request';
}

// 风险态判定：权限档位可见（基线 P0 缺口 5）—— Composer 胶囊据此转警示色
export function isRiskyApproval(approval) {
  const mode = migrateApprovalMode(approval?.approval_mode);
  const sandbox = approval?.sandbox_policy;
  return mode === 'never' || sandbox === 'full-access';
}

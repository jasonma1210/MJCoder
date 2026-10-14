// 审批/沙箱档位唯一常量源（A10 / 报告第 8 节）
// ComposerControls 与 SettingsModal 共用，禁止再各自维护值域。
// 历史值域冲突：Composer 曾用 auto / always-ask，设置页曾用 auto-safe / always —— 读取时一律迁移。
export const APPROVAL_MODES = [
  { id: 'on-request', name: '按需审批', desc: '沙箱内自动执行，危险命令与文件写入询问人（默认）' },
  { id: 'auto-safe', name: '安全自动', desc: '文件写入自动执行，危险命令与 MCP 工具仍询问' },
  { id: 'always', name: '每次询问', desc: '所有工具执行均需确认' },
  { id: 'never', name: '自动执行', desc: '全部自动执行，不弹出任何确认，有数据丢失风险' },
];

export const SANDBOX_MODES = [
  { id: 'read-only', name: '只读', desc: '禁止写入与执行命令，仅回答问题' },
  { id: 'workspace-write', name: '工作区写入', desc: '可读写项目目录内文件并执行命令（推荐）' },
  { id: 'full-access', name: '完全访问', desc: '可编辑任意文件并执行命令，有数据丢失风险' },
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

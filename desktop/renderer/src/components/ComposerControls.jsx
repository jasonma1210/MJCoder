import ModelSelector from './ModelSelector';
import { IconAlert, IconBranch, IconCpu, IconShield } from './icons';
import { APPROVAL_MODES, SANDBOX_MODES, migrateApprovalMode, isRiskyApproval } from '../constants/approval';

// Composer 任务控制台（对标 Codex 输入框周围区域）
// 模型 / 权限档位 / 运行模式三项常驻，其余能力在 D 批补齐
// A10：档位值域统一到 constants/approval.js（此前与设置页两处值域冲突，设置实际失效）
export const PERMISSION_OPTIONS = APPROVAL_MODES.map((m) => ({ value: m.id, label: m.name }));

export const SANDBOX_OPTIONS = SANDBOX_MODES.map((m) => ({ value: m.id, label: m.name }));

export const MODE_OPTIONS = [
  { value: 'local', label: '本地模式', hint: '直接在项目目录修改' },
  { value: 'worktree', label: '隔离工作区', hint: '在 Git worktree 副本中修改，不影响主目录' },
];

export default function ComposerControls({ providers, selectedModel, onSelectModel, approval, onApprovalChange, project, mode, onModeChange, worktreeInfo }) {
  // 遗留值迁移：旧 auto / always-ask 读取时映射到新档位
  const approvalMode = migrateApprovalMode(approval?.approval_mode);
  const risky = isRiskyApproval(approval);
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* 运行模式：本地 / 隔离工作区 */}
      <label
        className={`text-[11px] px-2 py-1 rounded-md border flex items-center gap-1 ${mode === 'worktree' ? 'bg-accent-soft border-accent text-accent' : 'bg-surface border-border'}`}
        title={MODE_OPTIONS.find((o) => o.value === mode)?.hint}
      >
        <IconBranch size={12} />
        <select
          value={mode}
          onChange={(e) => onModeChange?.(e.target.value)}
          className="bg-transparent outline-none"
        >
          {MODE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      {mode === 'worktree' && worktreeInfo?.branch && (
        <span className="text-[11px] text-text2 truncate max-w-[160px]" title={`隔离分支：${worktreeInfo.branch}`}>
          {worktreeInfo.branch}
        </span>
      )}

      {/* 权限档位（风险态强化：自动执行 / 完全访问时转警示色 —— 权限档位必须可见） */}
      <label className={`text-[11px] px-2 py-1 rounded-md border flex items-center gap-1 ${risky ? 'bg-warn-bg border-warn text-warn' : 'bg-surface border-border hover:bg-hover'}`}>
        {risky ? <IconAlert size={12} /> : <IconShield size={12} className="text-text2" />}
        <select
          value={approvalMode}
          onChange={(e) => onApprovalChange?.({ approval_mode: e.target.value })}
          className={`bg-transparent outline-none ${risky ? 'text-warn' : 'text-text'}`}
          title={risky ? '高风险：当前档位下工具将自动执行，请确认你了解风险' : '审批档位：决定哪些操作需要你确认'}
        >
          {PERMISSION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>

      {/* 沙箱策略 */}
      <label className="text-[11px] px-2 py-1 rounded-md bg-surface border border-border flex items-center gap-1 hover:bg-hover">
        <IconBranch size={12} className="text-text2" />
        <select
          value={approval?.sandbox_policy || 'workspace-write'}
          onChange={(e) => onApprovalChange?.({ sandbox_policy: e.target.value })}
          className="bg-transparent outline-none text-text"
          title="沙箱策略：限制 Agent 能触碰的文件范围"
        >
          {SANDBOX_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>

      {/* 模型 */}
      <span className="flex items-center gap-1">
        <IconCpu size={12} className="text-text2" />
        <ModelSelector providers={providers} selected={selectedModel} onSelect={onSelectModel} />
      </span>
    </div>
  );
}
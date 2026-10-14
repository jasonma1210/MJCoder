import { useState } from 'react';
import { IconCheck, IconGitBranch, IconX } from './icons';
import { confirm } from './feedback';

// P1-H：隔离工作区收口条——worktree 此前「只建不收」：IPC（promote/sync/remove）早已就绪
// 但渲染层零调用，改动永久滞留副本，用户只能手动敲 git 命令。
// 三个动作均带确认对话框（清理为危险确认），结果经 onMsg 反馈，promote/remove 后回调 onClosed。
export default function WorktreeBar({ worktree, onClosed, onMsg }) {
  const [busy, setBusy] = useState('');
  if (!worktree?.path) return null;

  async function act(kind) {
    const cfg = {
      sync: {
        title: '合并回主目录',
        message: '将隔离工作区的改动合并回主目录。主目录必须为干净状态（无未提交改动），否则会被拒绝。',
        confirmLabel: '合并回主目录',
      },
      promote: {
        title: '提升为分支',
        message: `将隔离副本提升为正式分支（${worktree.branch || ''} → mj/ 前缀）并移除 worktree，改动保留在分支中，之后可自行合并或推送。`,
        confirmLabel: '提升为分支',
      },
      remove: {
        title: '清理工作区',
        message: '移除隔离工作区。未合并、未提升的改动将永久丢失。确定清理吗？',
        confirmLabel: '仍然清理',
        danger: true,
      },
    }[kind];
    const ok = await confirm(cfg);
    if (!ok) return;
    setBusy(kind);
    try {
      const r = kind === 'sync'
        ? await window.mjcode.syncWorktree({ path: worktree.path })
        : kind === 'promote'
          ? await window.mjcode.promoteWorktree({ path: worktree.path })
          : await window.mjcode.removeWorktree({ path: worktree.path });
      if (r?.ok) {
        onMsg?.(kind === 'remove' ? '已清理隔离工作区'
          : kind === 'promote' ? `已提升为分支 ${r.branch || ''}`
            : '已合并回主目录');
        if (kind !== 'sync') onClosed?.(); // promote/remove 后工作区已不存在
      } else {
        onMsg?.(r?.error || '操作失败');
      }
    } catch (err) {
      onMsg?.(err.message || '操作失败');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="max-w-3xl w-full mx-auto mb-3 flex items-center gap-2 flex-wrap bg-accent-soft border border-accent/40 rounded-lg px-3 py-2">
      <IconGitBranch size={13} className="text-accent shrink-0" />
      <span className="text-xs text-text truncate" title={`${worktree.branch || ''} → ${worktree.path}`}>
        隔离工作区：{worktree.branch || worktree.path}
      </span>
      <span className="text-[11px] text-text2">改动不影响主目录，任务完成后可收口：</span>
      <div className="flex items-center gap-1.5 ml-auto">
        <button onClick={() => act('sync')} disabled={busy}
          className="text-[11px] px-2 py-1 rounded-md border border-border hover:bg-hover disabled:opacity-50 flex items-center gap-1"
          title="将隔离工作区的改动合并回主目录">
          <IconCheck size={11} />合并回主目录
        </button>
        <button onClick={() => act('promote')} disabled={busy}
          className="text-[11px] px-2 py-1 rounded-md border border-border hover:bg-hover disabled:opacity-50 flex items-center gap-1"
          title="提升为正式分支（mj/ 前缀）并移除 worktree">
          <IconGitBranch size={11} />提升为分支
        </button>
        <button onClick={() => act('remove')} disabled={busy}
          className="text-[11px] px-2 py-1 rounded-md border border-danger text-danger hover:bg-danger-bg disabled:opacity-50 flex items-center gap-1"
          title="移除隔离工作区（未合并改动将丢失）">
          <IconX size={11} />清理
        </button>
      </div>
    </div>
  );
}

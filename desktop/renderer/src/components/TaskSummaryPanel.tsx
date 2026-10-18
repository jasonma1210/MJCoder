import { useCallback, useEffect, useRef, useState } from 'react';
import SubtaskTree, { type SubagentEvent } from './tools/SubtaskTree';
import PanelEmpty from './PanelEmpty';
import { IconBot } from './icons';
import { useI18n } from '../i18n';

// 任务摘要面板（对标 Codex 右栏「任务摘要」）：把「这一轮任务都干了什么」收成一屏。
//
// 两部分数据源，都是既有权威通道，不新造状态：
//   1. 任务组快照 —— 主进程 tasks:list（含 thread_id / cwd 归属），事件 tasks:event 增量刷新；
//   2. 子代理 DAG —— ChatArea 上抛的 subagent 事件流（DAG 可视化由 SubtaskTree 负责）。
//
// 为什么不做成弹层：编排是长任务的常态，用户需要「边看对话边看进度」，
// 弹层会遮住正文且关掉即丢上下文（与右栏其他面板同理）。

const REFRESH_DEBOUNCE_MS = 400;

interface TaskSummaryPanelProps {
  threadId?: string | null;
  cwd?: string;
  events?: SubagentEvent[];
}

interface TaskGroupRow {
  group_id: string;
  goal?: string;
  status?: string;
  error?: string;
  thread_id?: string | null;
  cwd?: string;
}

interface TasksListResult {
  ok?: boolean;
  groups?: TaskGroupRow[];
}

const KNOWN_STATUS = ['ready', 'running', 'paused', 'failed', 'done', 'cancelled'] as const;

function groupStatusKey(status?: string): string {
  return status && (KNOWN_STATUS as readonly string[]).includes(status)
    ? `agentDock.groupStatus${status[0].toUpperCase()}${status.slice(1)}`
    : '';
}

function statusTone(status?: string): string {
  if (status === 'failed') return 'text-danger';
  if (status === 'paused') return 'text-warn';
  if (status === 'running') return 'text-accent';
  return 'text-text2';
}

export default function TaskSummaryPanel({ threadId = null, cwd = '', events = [] }: TaskSummaryPanelProps) {
  const { t } = useI18n();
  const [groups, setGroups] = useState<TaskGroupRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(async () => {
    const mj = window.mjcode;
    if (!mj?.tasksList) { setLoaded(true); return; }
    try {
      const r = await mj.tasksList({ limit: 30 }) as TasksListResult | undefined;
      const list = Array.isArray(r?.groups) ? r.groups : [];
      // 归属过滤：有 thread_id 的按会话匹配；历史组（无 thread_id）按 cwd 匹配
      const mine = list.filter((g) => (g.thread_id
        ? String(g.thread_id) === String(threadId ?? '')
        : String(g.cwd || '') === String(cwd || '')));
      setGroups(mine);
    } catch (err) {
      console.warn('[taskSummary] load groups failed:', err);
    } finally {
      setLoaded(true);
    }
  }, [threadId, cwd]);

  useEffect(() => { refresh(); }, [refresh]);

  // 任务事件增量刷新（合并 400ms，避免高频 task_activity 打爆 IPC）
  useEffect(() => {
    const mj = window.mjcode;
    if (!mj?.onTasksEvent) return undefined;
    const off = mj.onTasksEvent(() => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => { refresh(); }, REFRESH_DEBOUNCE_MS);
    }) as (() => void) | undefined;
    return () => { clearTimeout(timerRef.current); off?.(); };
  }, [refresh]);

  const hasEvents = Array.isArray(events) && events.length > 0;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {/* 任务组快照 */}
      <div className="px-2 py-2 border-b border-border">
        <div className="flex items-center gap-2 mb-1">
          <IconBot size={12} className="text-text2 shrink-0" />
          <span className="text-caption text-text2">{t('rightPane.taskGroups')}</span>
          {groups.length > 0 && <span className="text-caption text-text2">{groups.length}</span>}
        </div>
        {groups.length === 0 && (
          <div className="text-xs text-text2 py-1">{loaded ? t('rightPane.noTaskGroup') : t('rightPane.loading')}</div>
        )}
        <div className="space-y-1">
          {groups.map((g) => (
            <div key={g.group_id} className="rounded-lg border border-border bg-bg px-2 py-2">
              <div className="flex items-center gap-2">
                <span className={`text-caption shrink-0 ${statusTone(g.status)}`}>
                  {groupStatusKey(g.status) ? t(groupStatusKey(g.status)) : g.status}
                </span>
                <span className="text-xs truncate flex-1" title={g.goal || g.group_id}>{g.goal || g.group_id}</span>
              </div>
              {g.error && <div className="text-caption text-warn break-all mt-1">{g.error}</div>}
            </div>
          ))}
        </div>
      </div>

      {/* 子代理 DAG / 单代理卡片 */}
      <div className="min-h-0">
        {hasEvents
          ? <SubtaskTree events={events} />
          : <PanelEmpty icon={IconBot} title={t('rightPane.noSubtask')} hint={t('rightPane.noSubtaskHint')} />}
      </div>
    </div>
  );
}

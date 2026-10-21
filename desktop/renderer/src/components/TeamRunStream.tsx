// M5 / T5-6：对话内团队协同事件流（设计稿 v1.5 §13.5 重定义）。
//
// 形态（用户口径）：军团是「加入到当前对话里协同」，不是另开一个群聊页。
//   · 每次派活投影为一张卡片，**默认折叠**；点开才看「任务轨迹 + 协同消息」；
//   · 卡片顺序 = 建组时间升序（与对话从旧到新一致），栈在消息流末尾；
//   · 层级视图（Agent 胶囊 / 子任务树）仍在 AgentDock/右栏，本组件**不重复**渲染它们。
//
// 数据来源只有一条：`teams:listThreadRuns`（按 thread_id 反查团队 run，主进程已把
// 总线消息与看板任务拼好）。本组件不做第二套关联判断，只调 shared/teamStream.mjs 做纯投影。
//
// 刷新策略：首次进入拉一次；此后订阅 `teams:event`（消息落库/派活）与 `tasks:event`
// （组与任务状态推进），合并 500ms 再拉。团队 run 的状态既会经任务事件变化，也会经消息事件
// 变化，只订阅其中一条都会出现「消息到了、状态还停在运行中」的半截界面。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { IconBot, IconChevronDown, IconFile } from './icons';
import Button from './ui/Button';
import { projectTeamRuns, memberLabel } from '../../../shared/teamStream.mjs';
import { kindKey, messageText } from '../../../shared/teamLabels.mjs';
import { TASK_STATUS_KEY, taskEventText, timeLabel, isPathLike } from '../../../shared/teamTrace.mjs';
import TeamBoard, { type TeamBoardCard } from './TeamBoard';

const REFRESH_DEBOUNCE_MS = 500;

interface TeamStreamMember {
  id: string;
  name: string;
  roleKind: 'lead' | 'member';
  avatar: string | null;
  enabled: boolean;
}

// 任务处理轨迹（T5-6，2026-10-21）：来自 task_events 的 activity / status 两类事件。
// payload 只含渲染最小字段（textKey/textParams/kind/text/status），正文不落轨迹表。
interface TeamStreamEvent {
  id: number;
  groupId: string | null;
  taskId: string | null;
  type: string;
  payload: {
    kind?: string;
    textKey?: string;
    textParams?: Record<string, unknown> | null;
    text?: string;
    name?: string;
    status?: string;
    title?: string;
    error?: string;
  } | null;
  createdAt: number;
}

interface TeamStreamTask {
  taskId: string;
  title: string;
  status: string;
  ownerMemberId: string | null;
  ownerName: string;
  resultSummary: string;
  // 产物路径（任务 result.artifacts）：展开后可点击在右侧预览栏打开（T5-6 遗留项）
  artifacts?: string[];
  // 该任务的处理流程（工具调用 / 撤员 / 改派 / 等待 / 状态推进）
  events?: TeamStreamEvent[];
  error: string;
  // 看板列需要的依赖/关键路径/运行期等待边（投影层已归一，缺省为空数组）
  dependsOn?: string[];
  critical?: boolean;
  waitingOn?: string[];
}

interface TeamStreamMessage {
  id: string;
  seq: number;
  kind: string;
  summary: string;
  fromMemberId: string | null;
  toMemberId: string | null;
  refs: string[];
  // reason：中断留痕的理由（T5-10，Lead 中断必填，界面原样展示）
  payload: { sys?: string; name?: string; reason?: string } | null;
  createdAt: number;
}

interface TeamStreamCard {
  runId: string;
  // team = 军团派活；orchestration = 普通任务编排（统一显示，2026-10-21）
  kind?: 'team' | 'orchestration';
  teamId: string;
  teamName: string;
  status: string;
  goal: string;
  summary: string;
  error: string;
  waves: number;
  // 第八轮 B-05：派活计划口径——参与人数 / 被闸门挡下的人数 / 挡下的原因码（typeCap|memberCap）。
  // 缺键（旧 run、普通编排组）时全为 0 / 空，界面按 0 不展示。
  dispatch?: { mode: string; active: number; deferred: number; deferredReasons: string[] };
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  members: TeamStreamMember[];
  messages: TeamStreamMessage[];
  tasks: TeamStreamTask[];
  progress: { total: number } & Record<string, number>;
  counts: { total: number; byKind: Record<string, number> };
}

interface TeamRunStreamProps {
  threadId: string | null;
  // 产物路径点击 → 右侧预览栏打开（与 MessageStream 的文件 chips 同一回调）
  onOpenFile?: (path: string) => void;
}

// 组状态 → i18n key（与 AgentDock 共用一套文案，不另造词）
const GROUP_STATUS_KEY: Record<string, string> = {
  ready: 'agentDock.groupStatusReady',
  running: 'agentDock.groupStatusRunning',
  paused: 'agentDock.groupStatusPaused',
  failed: 'agentDock.groupStatusFailed',
  done: 'agentDock.groupStatusDone',
  cancelled: 'agentDock.groupStatusCancelled',
};

// 任务状态 → i18n key 与「事件 → 文案」口径统一在 shared/teamTrace.mjs（与看板共用一份）。

function groupTone(status: string): string {
  if (status === 'failed') return 'text-danger';
  if (status === 'paused') return 'text-warn';
  if (status === 'running') return 'text-accent';
  if (status === 'done') return 'text-success';
  return 'text-text2';
}

function taskTone(status: string): string {
  if (status === 'failed') return 'text-danger';
  if (status === 'waiting' || status === 'queued' || status === 'pending') return 'text-warn';
  if (status === 'running') return 'text-accent';
  if (status === 'done') return 'text-success';
  return 'text-text2';
}

type TFn = (key: string, params?: Record<string, string | number>) => string;

/** 轨迹事件 → 可读文本（口径见 shared/teamTrace.mjs）。 */
const eventText = (t: TFn, evt: TeamStreamEvent): string => taskEventText(t, evt);

/** 产物/引用路径 → 可点击打开（无回调时降级为只读文本，保证纯展示宿主不报错）。 */
function PathChip({ path, onOpenFile }: { path: string; onOpenFile?: (p: string) => void }) {
  if (!onOpenFile || !isPathLike(path)) {
    return <span className="text-caption text-text2 break-all">{path}</span>;
  }
  return (
    <Button
      variant="ghost"
      size="xs"
      className="max-w-full justify-start px-1"
      title={path}
      onClick={() => onOpenFile(path)}
    >
      <IconFile size={11} className="shrink-0" />
      <span className="truncate text-accent underline">{path}</span>
    </Button>
  );
}

export default function TeamRunStream({ threadId, onOpenFile }: TeamRunStreamProps) {
  const { t } = useI18n();
  const [cards, setCards] = useState<TeamStreamCard[]>([]);
  // 看板弹层：点卡片头部的「看板」打开；数据直接复用当前 run 的投影（父层刷新即同步）
  const [board, setBoard] = useState<TeamStreamCard | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!threadId) { setCards([]); return; }
    try {
      const r = (await window.mjcode?.teamsListThreadRuns?.({ threadId })) as
        { ok?: boolean; runs?: unknown[] } | undefined;
      if (!r?.ok) return;
      setCards(projectTeamRuns(r.runs) as TeamStreamCard[]);
    } catch {
      // 读取失败保留上一次投影：团队卡是辅助信息，不阻塞主对话
    }
  }, [threadId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const mj = window.mjcode;
    if (!threadId || (!mj?.onTeamsEvent && !mj?.onTasksEvent)) return undefined;
    const bump = () => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => { refresh(); }, REFRESH_DEBOUNCE_MS);
    };
    const offTeams = mj.onTeamsEvent?.(bump) as (() => void) | undefined;
    const offTasks = mj.onTasksEvent?.(bump) as (() => void) | undefined;
    return () => {
      clearTimeout(timerRef.current);
      offTeams?.();
      offTasks?.();
    };
  }, [threadId, refresh]);

  if (!threadId || cards.length === 0) return null;

  // 最新一次、且仍在推进的 run 默认展开：此前全部折叠，用户只看到一行摘要，
  // 体感就是「派活后什么都没发生」（真机反馈）。历史/终态卡片仍保持折叠，避免刷屏。
  const latestId = cards[cards.length - 1]?.runId;
  // 看板弹层跟随最新一次刷新（同一 runId 时用新对象，任务状态才会实时推进）
  const liveBoard = board ? cards.find((c) => c.runId === board.runId) || board : null;
  // 统一显示（2026-10-21）：全部为普通编排时，标题也换成「任务编排」，避免叫「团队协同」却无团队。
  const titleKey = cards.some((c) => c.kind === 'team')
    ? 'teams.streamTitle' : 'teams.streamTitleOrchestration';

  return (
    <div className="mb-3 max-w-3xl">
      <div className="flex items-center gap-2 mb-1 text-caption text-text2">
        <IconBot size={12} className="shrink-0" />
        <span>{t(titleKey)}</span>
        <span>{cards.length}</span>
      </div>
      {cards.map((card) => (
        <TeamRunCard
          key={card.runId}
          card={card}
          defaultOpen={card.runId === latestId && ['ready', 'running', 'paused'].includes(card.status)}
          onOpenBoard={() => setBoard(card)}
          onOpenFile={onOpenFile}
        />
      ))}
      <TeamBoard card={liveBoard as TeamBoardCard | null} onClose={() => setBoard(null)} onOpenFile={onOpenFile} />
    </div>
  );
}

function TeamRunCard({ card, defaultOpen, onOpenBoard, onOpenFile }: {
  card: TeamStreamCard;
  defaultOpen: boolean;
  onOpenBoard: () => void;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useI18n();
  // 受控展开：默认展开只作为初值，用户点开/收起后由本地状态接管（不再被刷新强行拉回）
  const [open, setOpen] = useState(defaultOpen);
  const statusKey = GROUP_STATUS_KEY[card.status];
  const done = card.progress.done || 0;
  const total = card.progress.total || 0;
  const running = card.progress.running || 0;
  const waiting = card.progress.waiting || 0;
  const waves = card.waves > 0 ? t('teams.streamWaves', { n: card.waves }) : '';
  // 第八轮 B-05：被人数闸/类型闸挡下的成员数。只显示人数，原因码（typeCap / memberCap）
  // 走 title 提示——折叠态挤不下第三种文案，而「有几个没上」才是用户第一眼要看的。
  const deferred = card.dispatch?.deferred || 0;
  const deferredHint = (card.dispatch?.deferredReasons || []).join(' / ');

  return (
    <details
      className="group mb-2 rounded-xl border border-border bg-input/40 open:bg-input"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
        <span
          className="text-xs text-text2 shrink-0 max-w-[9rem] truncate"
          title={card.teamName || t('teams.streamKindOrchestration')}
        >
          {card.teamName || t('teams.streamKindOrchestration')}
        </span>
        <span className="text-xs truncate flex-1" title={card.goal || card.runId}>
          {card.goal || t('teams.streamRunFallbackGoal')}
        </span>
        {waves && <span className="text-caption text-text2 shrink-0">{waves}</span>}
        {deferred > 0 && (
          <span className="text-caption text-text2 shrink-0" title={deferredHint || undefined}>
            {t('teams.streamDeferred', { n: deferred })}
          </span>
        )}
        {running > 0 && (
          <span className="text-caption text-accent shrink-0">{t('teams.streamRunning', { n: running })}</span>
        )}
        {waiting > 0 && (
          <span className="text-caption text-warn shrink-0">{t('teams.streamWaiting', { n: waiting })}</span>
        )}
        <span className="text-caption text-text2 shrink-0">{t('teams.streamProgress', { done, total })}</span>
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpenBoard(); }}
        >
          <span className="text-accent">{t('teams.boardOpen')}</span>
        </Button>
        <span className={`text-caption shrink-0 ${groupTone(card.status)}`}>
          {statusKey ? t(statusKey) : card.status}
        </span>
        <IconChevronDown size={12} className="text-text2 shrink-0 transition-transform group-open:rotate-180" />
      </summary>

      <div className="px-3 pb-3 pt-2 space-y-3 border-t border-border">
        {card.summary && (
          <div className="text-xs text-text2 whitespace-pre-wrap break-words">{card.summary}</div>
        )}
        {card.error && <div className="text-caption text-warn break-all">{card.error}</div>}

        <section>
          <div className="text-caption text-text2 mb-1">{t('teams.streamTasks')}</div>
          {card.tasks.length === 0 && <div className="text-caption text-text2">{t('teams.streamNoTasks')}</div>}
          <div className="space-y-1">
            {card.tasks.map((task) => (
              <TaskRow key={task.taskId} task={task} onOpenFile={onOpenFile} />
            ))}
          </div>
        </section>

        <section>
          <div className="text-caption text-text2 mb-1">{t('teams.streamMessages')}</div>
          {card.messages.length === 0 && (
            <div className="text-caption text-text2">{t('teams.streamNoMessages')}</div>
          )}
          <ol className="space-y-1">
            {card.messages.map((m) => {
              const from = memberLabel(card, m.fromMemberId);
              const to = memberLabel(card, m.toMemberId);
              return (
                <li key={m.id} className="flex items-start gap-2 text-xs">
                  <span className="text-caption text-text2 shrink-0 w-16 truncate">{t(kindKey(m.kind))}</span>
                  {(from || to) && (
                    <span className="text-caption text-text2 shrink-0 max-w-[10rem] truncate" title={[from, to].filter(Boolean).join(' → ')}>
                      {[from, to].filter(Boolean).join(' → ')}
                    </span>
                  )}
                  <span className="flex-1 min-w-0 break-words">{messageText(t, m)}</span>
                </li>
              );
            })}
          </ol>
          {card.messages.some((m) => m.refs.length > 0) && (
            <div className="mt-1 space-y-1">
              {card.messages.flatMap((m) => m.refs.map((ref, i) => (
                <div key={`${m.id}-${i}`} className="flex items-start gap-1 text-caption">
                  <span className="text-text2 shrink-0">{t('teams.streamRefs')} ·</span>
                  <PathChip path={ref} onOpenFile={onOpenFile} />
                </div>
              )))}
            </div>
          )}
        </section>
      </div>
    </details>
  );
}

// 单个任务的展开行（2026-10-21 真机反馈：此前任务只显示「执行中」，用户看不到它到底做了什么）。
// 展开内容 = 处理轨迹（task_events 投影的 activity/status）+ 完整产出 + 错误 + 产物路径。
// 轨迹与产物都来自主进程装配好的只读投影，这里不做第二套查询。
function TaskRow({ task, onOpenFile }: {
  task: TeamStreamTask;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const statusKey = TASK_STATUS_KEY[task.status];
  const events = task.events || [];
  const artifacts = task.artifacts || [];

  return (
    <details
      className="rounded-lg border border-border bg-bg"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex items-center gap-2 px-2 py-1 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
        <span className={`text-caption shrink-0 ${taskTone(task.status)}`}>
          {statusKey ? t(statusKey) : task.status}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs truncate" title={task.title}>{task.title}</span>
          {task.resultSummary && (
            <span className="block text-caption text-text2 truncate">{task.resultSummary}</span>
          )}
        </span>
        {events.length > 0 && (
          <span className="text-caption text-text2 shrink-0">
            {t('teams.streamTraceCount', { n: events.length })}
          </span>
        )}
        <span className="text-caption text-text2 shrink-0 max-w-[8rem] truncate">
          {task.ownerName || t('teams.streamUnclaimed')}
        </span>
        <IconChevronDown
          size={11}
          className={`shrink-0 text-text2 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </summary>

      <div className="px-2 pb-2 pt-1 space-y-2 border-t border-border">
        <div>
          <div className="text-caption text-text2 mb-1">{t('teams.streamTaskTrace')}</div>
          {events.length === 0 && <div className="text-caption text-text2">{t('teams.streamNoTrace')}</div>}
          <ol className="space-y-1">
            {events.map((evt) => (
              <li key={evt.id} className="flex items-start gap-2 text-caption">
                <span className="text-text2 shrink-0 tabular-nums">{timeLabel(evt.createdAt)}</span>
                <span className="flex-1 min-w-0 break-words">{eventText(t, evt)}</span>
              </li>
            ))}
          </ol>
        </div>
        {task.resultSummary && (
          <div>
            <div className="text-caption text-text2 mb-1">{t('teams.streamTaskResult')}</div>
            <div className="text-xs whitespace-pre-wrap break-words">{task.resultSummary}</div>
          </div>
        )}
        {task.error && (
          <div className="text-caption text-warn break-all">{t('teams.boardError')} · {task.error}</div>
        )}
        {artifacts.length > 0 && (
          <div>
            <div className="text-caption text-text2 mb-1">{t('teams.streamTaskArtifacts')}</div>
            <div className="space-y-1">
              {artifacts.map((p) => <PathChip key={p} path={p} onOpenFile={onOpenFile} />)}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

// T1-4：子任务树 / DAG 可视化（右栏「子任务」tab）
//
// 数据源：T1-3 的 subagent 事件流（shared-ipc/contract.mjs subagentDataSchema）。
// 两类形态：
//   · orchestrate_task（编排组）：按 groupId 分组，节点=子任务、边=dependsOn（spawn 事件携带）。
//     不引第三方图库——DAG 用「分层布局 + 依赖徽标」表意：层级即执行波次，
//     同层任务无依赖关系可并行，节点内的「依赖 t1 t2」徽标标明上游。
//   · spawn_subagent（单代理）：单节点卡（objective 摘要 + tokens + 结论）。
// 状态色全部走 theme.css 语义 token（与 tailwind.config.js 映射），禁止裸色值。
// 交互：点击节点就地展开结论摘要（非模态），再点收起。
import { useState } from 'react';
import { useI18n } from '../../i18n'; // T3-2：i18n
import { IconAlert, IconCheck, IconDot, IconSpinner } from '../icons';

// 与 shared-ipc SubagentEventData 对齐的局部类型（渲染层不直接 import 契约 d.mts）
export interface SubagentEvent {
  tool: 'spawn_subagent' | 'orchestrate_task';
  phase: 'spawn' | 'progress' | 'done' | 'failed';
  objective?: string;
  taskType?: string;
  groupId?: string;
  taskId?: string;
  title?: string;
  dependsOn?: string[];
  tokens?: number;
  budgetKind?: string;
  round?: number;
  ms?: number;
  summary?: string;
  error?: string;
}

interface TaskNode {
  taskId: string;
  title: string;
  dependsOn: string[];
  phase: 'spawn' | 'progress' | 'done' | 'failed';
  tokens: number;
  summary: string;
  error: string;
  budgetKind: string;
}

const PHASE_ORDER: Record<TaskNode['phase'], number> = { spawn: 0, progress: 1, done: 2, failed: 2 };

// 同一节点的多条事件（spawn→progress→…→done/failed）合并为最新状态；
// tokens 取后到值（引擎侧上报的即是累计值，非增量）。
function mergeNode(prev: TaskNode, evt: SubagentEvent): TaskNode {
  return {
    taskId: prev.taskId,
    title: evt.title || prev.title,
    dependsOn: evt.dependsOn && evt.dependsOn.length ? evt.dependsOn : prev.dependsOn,
    phase: PHASE_ORDER[evt.phase] >= PHASE_ORDER[prev.phase] ? evt.phase : prev.phase,
    tokens: typeof evt.tokens === 'number' ? evt.tokens : prev.tokens,
    summary: evt.summary || prev.summary,
    error: evt.error || prev.error,
    budgetKind: evt.budgetKind || prev.budgetKind,
  };
}

// DAG 分层：level(t) = deps 为空 ? 0 : max(level(dep)) + 1。
// 契约不承诺无环（编排器建组时已校验），深度上限兜底防死循环。
const MAX_LEVEL_DEPTH = 32;
function computeLevels(nodes: Map<string, TaskNode>): Map<string, number> {
  const memo = new Map<string, number>();
  const visit = (id: string, depth: number): number => {
    if (memo.has(id)) return memo.get(id) as number;
    if (depth > MAX_LEVEL_DEPTH) return 0;
    const node = nodes.get(id);
    const level = !node || node.dependsOn.length === 0
      ? 0
      : Math.max(...node.dependsOn.map((d) => (nodes.has(d) ? visit(d, depth + 1) : -1))) + 1;
    memo.set(id, level);
    return level;
  };
  for (const id of nodes.keys()) visit(id, 0);
  return memo;
}

function fmtTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// 状态点：待运行=灰点 / 运行中=旋转 / 完成=绿勾 / 失败=红叹号（全部 theme token）
function PhaseIcon({ phase }: { phase: TaskNode['phase'] }) {
  if (phase === 'progress') return <IconSpinner size={12} className="animate-spin text-accent shrink-0" />;
  if (phase === 'done') return <IconCheck size={12} className="text-success shrink-0" />;
  if (phase === 'failed') return <IconAlert size={12} className="text-danger shrink-0" />;
  return <IconDot size={12} className="text-text2 shrink-0" />;
}

// 顶层常量只存 key（求值推迟到渲染时经 t()，切换语言即时更新）
const PHASE_LABEL: Record<TaskNode['phase'], string> = {
  spawn: 'subtaskTree.phaseSpawn', progress: 'subtaskTree.phaseRunning',
  done: 'subtaskTree.phaseDone', failed: 'subtaskTree.phaseFailed',
};

// 单个节点卡：状态图标 + 标题 + tokens 角标；失败恒显原因，其余点击就地展开结论
function NodeCard({ node }: { node: TaskNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const expandable = !!(node.summary || node.error);
  return (
    <button
      onClick={() => expandable && setOpen(!open)}
      className={`text-left w-full rounded-lg border border-border bg-surface px-2.5 py-2 space-y-1 ${
        expandable ? 'hover:border-strong cursor-pointer' : 'cursor-default'
      }`}
      title={expandable ? t('subtaskTree.clickToView') : t(PHASE_LABEL[node.phase])}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <PhaseIcon phase={node.phase} />
        <span className="truncate flex-1 text-text">{node.title || node.taskId}</span>
        {node.tokens > 0 && (
          <span className="shrink-0 text-caption text-text2 border border-border rounded px-1 py-px">
            {fmtTokens(node.tokens)} tk
          </span>
        )}
      </div>
      {node.dependsOn.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap text-caption text-text2">
          {t('subtaskTree.dependsOn')}
          {node.dependsOn.map((d) => (
            <span key={d} className="border border-border rounded px-1 py-px">{d}</span>
          ))}
        </div>
      )}
      {node.error && <div className="text-xs text-danger break-all">{node.error}</div>}
      {!node.error && node.budgetKind && node.budgetKind !== 'normal' && (
        <div className="text-xs text-warn">
          {t('subtaskTree.earlyStop', { reason: node.budgetKind === 'tokens' ? t('subtaskTree.stopTokens') : node.budgetKind === 'rounds' ? t('subtaskTree.stopRounds') : t('subtaskTree.stopAborted') })}
        </div>
      )}
      {open && node.summary && <div className="text-xs text-text2 whitespace-pre-wrap break-all border-t border-border pt-1">{node.summary}</div>}
    </button>
  );
}

// 单代理卡（spawn_subagent 无 DAG 结构）：objective 为主体的轻量节点
function SingleCard({ evt }: { evt: SubagentEvent }) {
  const { t } = useI18n();
  const node: TaskNode = {
    taskId: evt.taskType || t('subtaskTree.subagent'),
    title: evt.objective || t('subtaskTree.subagentTask'),
    dependsOn: [],
    phase: evt.phase === 'spawn' ? 'spawn' : evt.phase === 'progress' ? 'progress' : evt.phase,
    tokens: evt.tokens || 0,
    summary: evt.summary || '',
    error: evt.error || '',
    budgetKind: evt.budgetKind || '',
  };
  return (
    <div className="space-y-1">
      <div className="text-xs text-text2">{t('subtaskTree.singleAgent', { type: evt.taskType || t('subtaskTree.general') })}</div>
      <NodeCard node={node} />
    </div>
  );
}

export default function SubtaskTree({ events }: { events: SubagentEvent[] }) {
  const { t } = useI18n();
  // 编排组：groupId -> 节点表；单代理：按到达顺序开卡（引擎 spawn 顺序执行不交错）
  const groups = new Map<string, Map<string, TaskNode>>();
  const singles: SubagentEvent[] = [];
  let lastSingle: SubagentEvent | null = null; // progress/done 归属最近开启的单代理

  for (const evt of events) {
    if (evt.tool === 'orchestrate_task' && evt.groupId && evt.taskId) {
      if (!groups.has(evt.groupId)) groups.set(evt.groupId, new Map());
      const nodes = groups.get(evt.groupId) as Map<string, TaskNode>;
      const blank: TaskNode = {
        taskId: evt.taskId, title: evt.title || evt.taskId,
        dependsOn: Array.isArray(evt.dependsOn) ? evt.dependsOn : [],
        phase: 'spawn', tokens: 0, summary: '', error: '', budgetKind: '',
      };
      nodes.set(evt.taskId, nodes.has(evt.taskId) ? mergeNode(nodes.get(evt.taskId) as TaskNode, evt) : mergeNode(blank, evt));
    } else if (evt.tool === 'spawn_subagent') {
      if (evt.phase === 'spawn') {
        singles.push(evt);
        lastSingle = evt;
      } else if (lastSingle) {
        // 终态/进度归入最近开启的单代理（替换引用以保证渲染取到最新字段）
        const merged: SubagentEvent = { ...lastSingle, ...evt };
        singles[singles.length - 1] = merged;
        lastSingle = merged;
      }
    }
  }

  if (events.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text2 gap-2 p-8 text-center">
        <p className="text-sm">{t('subtaskTree.empty')}</p>
        <p className="text-xs">{t('subtaskTree.emptyHint')}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      {[...groups.entries()].map(([groupId, nodes]) => {
        const levels = computeLevels(nodes);
        const byLevel = new Map<number, TaskNode[]>();
        for (const node of nodes.values()) {
          const lv = levels.get(node.taskId) ?? 0;
          if (!byLevel.has(lv)) byLevel.set(lv, []);
          (byLevel.get(lv) as TaskNode[]).push(node);
        }
        const all = [...nodes.values()];
        const doneCount = all.filter((n) => n.phase === 'done').length;
        const failedCount = all.filter((n) => n.phase === 'failed').length;
        const totalTokens = all.reduce((s, n) => s + n.tokens, 0);
        return (
          <section key={groupId} className="space-y-2">
            <header className="flex items-center gap-2 text-xs text-text2">
              <span className="text-text">{t('subtaskTree.group')}</span>
              <span className="border border-border rounded px-1 py-px">{t('subtaskTree.doneRatio', { done: doneCount, total: all.length })}</span>
              {failedCount > 0 && <span className="text-danger border border-border rounded px-1 py-px">{t('subtaskTree.failedCount', { n: failedCount })}</span>}
              {totalTokens > 0 && <span className="border border-border rounded px-1 py-px">{fmtTokens(totalTokens)} tk</span>}
            </header>
            {/* 分层即执行波次：上层产出是下层输入；同层可并行 */}
            <div className="space-y-2 border-l border-border pl-3">
              {[...byLevel.keys()].sort((a, b) => a - b).map((lv) => (
                <div key={lv} className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
                  {(byLevel.get(lv) as TaskNode[]).map((node) => (
                    <NodeCard key={node.taskId} node={node} />
                  ))}
                </div>
              ))}
            </div>
          </section>
        );
      })}
      {singles.map((evt, i) => (
        <SingleCard key={`single-${i}`} evt={evt} />
      ))}
    </div>
  );
}

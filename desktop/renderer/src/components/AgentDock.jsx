import { useEffect, useRef, useState } from 'react';
import { IconAlert, IconBot, IconCheck, IconSpinner, IconX } from './icons';

// Agent 运行胶囊（WorkBuddy 式）：输入框上方左侧显示每个在役数字员工；
// 点胶囊展开面板——查看每个 Agent 的实时执行流程（工具调用流），可强制关闭。
// 数据源：tasks:event（task_update running→入列 / done|failed|skipped→出列；task_activity→流程流）。
// 命名：主进程 workerPool 分配可爱名（布丁/团子/芝麻…），经 task_update.name / task_activity.name 下发。

const ACTIVITY_LIMIT = 60;

// 事件流驱动 Agent 状态收集：全局唯一订阅，多组件复用不重复挂监听
let sharedState = { agents: new Map(), version: 0 };
const listeners = new Set();
let subscribed = false;

function ensureSubscribed() {
  if (subscribed || !window.mjcode?.onTasksEvent) return;
  subscribed = true;
  window.mjcode.onTasksEvent((evt) => {
    if (!evt?.type) return;
    const key = evt.groupId && evt.taskId ? `${evt.groupId}/${evt.taskId}` : null;
    if (!key) return;
    let changed = false;
    if (evt.type === 'task_update' && evt.status === 'running') {
      const prev = sharedState.agents.get(key);
      sharedState.agents.set(key, {
        key, groupId: evt.groupId, taskId: evt.taskId,
        name: evt.name || prev?.name || '小助手',
        title: evt.title || prev?.title || '',
        activities: prev?.activities || [],
      });
      changed = true;
    } else if (evt.type === 'task_update' && ['done', 'failed', 'skipped'].includes(evt.status)) {
      if (sharedState.agents.has(key)) { sharedState.agents.delete(key); changed = true; }
    } else if (evt.type === 'task_activity') {
      const a = sharedState.agents.get(key);
      if (a) {
        a.activities = [...a.activities, { kind: evt.kind, text: evt.text, name: evt.name }].slice(-ACTIVITY_LIMIT);
        changed = true;
      }
    }
    if (changed) {
      sharedState = { agents: new Map(sharedState.agents), version: sharedState.version + 1 };
      for (const l of listeners) l();
    }
  });
}

function useAgents() {
  const [, bump] = useState(0);
  useEffect(() => {
    ensureSubscribed();
    const l = () => bump((v) => v + 1);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  return [...sharedState.agents.values()];
}

// P3-5：资源额度快照轮询（挂载在展开面板内 → 仅面板打开期间轮询，卸载即停）
function useQuotaSnapshot() {
  const [snap, setSnap] = useState(null);
  useEffect(() => {
    let alive = true;
    const poll = () => window.mjcode?.quotaSnapshot?.()
      .then((s) => { if (alive && s) setSnap(s); }).catch(() => {});
    poll();
    const t = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return snap;
}

const THROTTLE_LABEL = {
  idle: '空闲',
  busy: '繁忙（后台任务让路中）',
  overloaded: '过载熔断（后台任务已暂停）',
};

function ActivityText({ kind, text }) {
  if (kind === 'tool') {
    return <span className="text-text2 break-all"><span className="text-accent">工具</span> {text}</span>;
  }
  if (kind === 'stop') return <span className="text-danger break-all">{text}</span>;
  return <span className="text-text break-all">{text}</span>;
}

// 展开面板：所有在役 Agent + 流程流 + 强制关闭/全部停止 + 资源额度页脚
function AgentDockPanel({ agents, onClose, onAbort, onAbortAll, allMsg }) {
  const groupIds = [...new Set(agents.map((a) => a.groupId))];
  const quota = useQuotaSnapshot();
  const providerEntries = Object.entries(quota?.providers || {});
  return (
    <div className="absolute bottom-full left-0 mb-2 w-[26rem] max-h-[24rem] flex flex-col bg-surface border border-border rounded-2xl shadow-[var(--shadow-pop)] z-30 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
        <div className="text-sm font-medium flex items-center gap-1.5"><IconBot size={15} /> 正在执行的 Agent（{agents.length}）</div>
        <div className="flex items-center gap-2">
          {agents.length > 0 && (
            <button onClick={() => onAbortAll(groupIds)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-danger text-danger text-xs hover:bg-danger-bg"
              title="停止全部在役 Agent（已完成的子任务结果保留）"
            >
              <IconAlert size={11} /> 全部停止
            </button>
          )}
          <button onClick={onClose} className="text-text2 hover:text-text p-1"><IconX size={13} /></button>
        </div>
      </div>
      {allMsg && <div className="px-4 py-1.5 text-xs text-warn bg-warn-bg">{allMsg}</div>}
      <div className="overflow-y-auto p-2 space-y-2">
        {agents.length === 0 && (
          <div className="text-text2 text-xs text-center py-6">暂无正在执行的 Agent——在对话中提出可并行的目标（如「多角色共同审查」），数字员工会自动出现在这里</div>
        )}
        {agents.map((a) => (
          <div key={a.key} className="bg-bg border border-border rounded-xl p-3">
            <div className="flex items-center gap-2 mb-2">
              <IconSpinner size={13} className="text-accent animate-spin shrink-0" />
              <span className="text-sm font-medium shrink-0">{a.name}</span>
              <span className="text-xs text-text2 truncate flex-1" title={a.title}>{a.title}</span>
              <button
                onClick={() => onAbort(a)}
                className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded border border-danger text-danger text-xs hover:bg-danger-bg"
                title="中止该 Agent 的执行（不会重试）"
              >
                <IconX size={11} /> 强制关闭
              </button>
            </div>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {a.activities.length === 0 && <div className="text-text2 text-xs">正在思考…</div>}
              {a.activities.slice().reverse().map((act, i) => (
                <div key={i} className="text-xs px-2 py-1 rounded bg-surface">
                  <ActivityText kind={act.kind} text={act.text} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {quota && (
        <div className="px-4 py-2 border-t border-border shrink-0 text-xs text-text2 flex items-center gap-x-3 gap-y-1 flex-wrap">
          <span>模型资源：{THROTTLE_LABEL[quota.throttle] || quota.throttle}</span>
          {providerEntries.map(([id, p]) => (
            <span key={id} title="前台=会话/Worker/编排请求，后台=记忆整理作业">
              {id}：前台 {p.fg}/{p.limit}{p.bg > 0 ? `，后台 ${p.bg}` : ''}{p.breakerOpen ? '，熔断中' : ''}
            </span>
          ))}
          {quota.localBackend?.ollama && (
            <span title="检测到本机 Ollama 服务，可在模型设置中配置 baseUrl http://localhost:11434/v1 使用">
              本地 Ollama（{quota.localBackend.models} 个模型）
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default function AgentDock() {
  const agents = useAgents();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const [allMsg, setAllMsg] = useState('');
  const timersRef = useRef([]);

  useEffect(() => () => { timersRef.current.forEach(clearTimeout); }, []);
  // 面板开着但所有 Agent 都结束 → 自动收起
  useEffect(() => { if (open && agents.length === 0) setOpen(false); }, [open, agents.length]);

  function flash(setter, text) {
    setter(text);
    const t = setTimeout(() => setter(''), 3000);
    timersRef.current.push(t);
  }

  async function abort(a) {
    try {
      const r = await window.mjcode.tasksAbortTask(a.groupId, a.taskId);
      flash(setMsg, r?.ok ? `已通知 ${a.name} 停止` : `关闭失败：${r?.error || '未知原因'}`);
    } catch (e) {
      flash(setMsg, `关闭失败：${e.message}`);
    }
  }

  async function abortAll(groupIds) {
    try {
      let n = 0;
      for (const gid of groupIds) {
        const r = await window.mjcode.tasksAbortGroup(gid);
        if (r?.ok) n += r.aborted || 0;
      }
      flash(setAllMsg, n > 0 ? `已停止 ${n} 个在役 Agent，已完成子任务的结果保留；可在对话中让 Agent 减少并行数重试` : '当前没有在役任务可停止');
    } catch (e) {
      flash(setAllMsg, `停止失败：${e.message}`);
    }
  }

  if (agents.length === 0 && !msg) return null;

  return (
    <div className="max-w-3xl w-full mx-auto relative mb-2">
      <div className="flex items-center gap-2 flex-wrap">
        {agents.map((a) => (
          <button
            key={a.key}
            onClick={() => setOpen(true)}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-surface border border-border text-xs hover:border-accent"
            title={`${a.name} 正在执行：${a.title}`}
          >
            <IconSpinner size={12} className="text-accent animate-spin" />
            <span className="font-medium">{a.name}</span>
            <span className="text-text2 max-w-[10rem] truncate">{a.title}</span>
          </button>
        ))}
        {agents.length > 1 && (
          <span className="text-xs text-text2">（{agents.length} 个并行）</span>
        )}
        {msg && (
          <span className="inline-flex items-center gap-1 text-xs text-text2">
            {msg.includes('失败') ? <IconAlert size={12} className="text-danger" /> : <IconCheck size={12} className="text-success" />}
            {msg}
          </span>
        )}
      </div>
      {open && <AgentDockPanel agents={agents} onClose={() => setOpen(false)} onAbort={abort} onAbortAll={abortAll} allMsg={allMsg} />}
    </div>
  );
}

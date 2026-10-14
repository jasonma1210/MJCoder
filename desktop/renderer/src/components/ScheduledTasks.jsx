import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import InlineAlert from './InlineAlert';
import { confirm } from './feedback';
import { IconCheck, IconClock, IconPlus, IconX } from './icons';

const STATUS_META = {
  success: { label: '成功', cls: 'text-success' },
  failed: { label: '失败', cls: 'text-danger' },
  running: { label: '执行中', cls: 'text-accent' },
};

// ── Cron 解析（5 字段：分 时 日 月 周），支持 * 数字 a-b 列表与 /步进 ──
function cronFieldOk(f) {
  return /^[\d*,\-/]+$/.test(f) && f.length > 0;
}

function cronFieldMatches(f, v) {
  return f.split(',').some((p) => {
    let base = p;
    let step = 1;
    if (p.includes('/')) {
      const parts = p.split('/');
      base = parts[0];
      step = Number(parts[1]) || 1;
    }
    if (base === '*' || base === '?') return v % step === 0;
    if (base.includes('-')) {
      const [a, b] = base.split('-').map(Number);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return v >= a && v <= b && (v - a) % step === 0;
    }
    const n = Number(base);
    return !Number.isNaN(n) && v === n;
  });
}

// 语法校验：返回错误文案或 null
function validateCron(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) return 'Cron 需为 5 个字段（分 时 日 月 周）';
  if (!fields.every(cronFieldOk)) return '字段只允许 数字、*、,、-、/';
  if (Number(fields[0]) > 59 || Number(fields[1]) > 23) return '分钟 ≤ 59、小时 ≤ 23';
  if (Number(fields[2]) > 31 || Number(fields[3]) > 12) return '日 ≤ 31、月 ≤ 12';
  if (Number(fields[4]) > 7) return '周字段取值 0-7（0/7 为周日）';
  return null;
}

// 下次运行时间：从下一分钟起逐分钟扫描（上限 366 天）；注释：日/周同时受限时按 AND 处理（本产品模板不涉及 OR 场景）
function nextCronRun(expr) {
  if (validateCron(expr)) return null;
  const fields = String(expr).trim().split(/\s+/);
  const d = new Date();
  d.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (
      cronFieldMatches(fields[0], d.getMinutes()) &&
      cronFieldMatches(fields[1], d.getHours()) &&
      cronFieldMatches(fields[2], d.getDate()) &&
      cronFieldMatches(fields[3], d.getMonth() + 1) &&
      cronFieldMatches(fields[4], d.getDay())
    ) return new Date(d);
  }
  return null;
}

// cron → 人话（TRAE 卡片同款「每天 10:00」样式；无法归约时回退原表达式）
function humanSchedule(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return expr;
  const [m, h, dom, mon, dow] = f;
  const time = /^\d+$/.test(h) && /^\d+$/.test(m)
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` : null;
  if (dom === '*' && mon === '*' && dow === '*') return time ? `每天 ${time}` : `每天（${expr}）`;
  if (dom === '*' && mon === '*' && dow === '1-5') return time ? `工作日 ${time}` : `工作日（${expr}）`;
  if (dom === '*' && mon === '*' && /^\d$/.test(dow)) {
    return time ? `每周${'日一二三四五六'[Number(dow) % 7]} ${time}` : expr;
  }
  return expr;
}

const REPEATS = [
  { id: 'daily', label: '每天', toCron: (t) => `${t.m} ${t.h} * * *` },
  { id: 'weekday', label: '工作日', toCron: (t) => `${t.m} ${t.h} * * 1-5` },
  { id: 'weekly', label: '每周一', toCron: (t) => `${t.m} ${t.h} * * 1` },
  { id: 'custom', label: '自定义（Cron）', toCron: null },
];

// 小开关（TRAE 卡片右侧同款）
function Switch({ on, onChange }) {
  return (
    <button onClick={onChange} role="switch" aria-checked={on}
      className={`w-10 h-[22px] rounded-full transition-colors relative shrink-0 ${on ? 'bg-accent' : 'bg-hover border border-border'}`}>
      <div className={`absolute w-[18px] h-[18px] rounded-full bg-white top-[1px] transition-all ${on ? 'left-[19px]' : 'left-[1px]'}`} />
    </button>
  );
}

export default function ScheduledTasks() {
  const [tasks, setTasks] = useState([]);
  const [filter, setFilter] = useState('all'); // all | enabled | disabled
  const [showForm, setShowForm] = useState(false);
  // Bug2：TRAE 同款表单——任务名称 + 提示词 + 重复/时间/有效期
  const [form, setForm] = useState({ name: '', prompt: '', repeat: 'daily', time: '09:00', schedule: '0 9 * * *', validType: 'forever', validUntil: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [expandedRuns, setExpandedRuns] = useState(null); // { taskId, list } — B1：绑定 taskId，避免历史展开污染所有卡片
  const [runResult, setRunResult] = useState(null); // { taskId, ok, text }

  async function load() {
    try {
      setTasks(await api.scheduledTasks());
    } catch (err) {
      console.warn('[scheduled] 加载失败:', err);
      setError('任务列表加载失败');
    }
  }

  useEffect(() => { load(); }, []);

  // Bug2：调度器到点执行/手动运行后主进程广播 → 自动刷新列表与展开中的运行记录
  // P1-6：showRuns 走 latest-ref 模式。它是普通 async 函数声明（每次渲染新建），
  // 直接列入依赖会让监听每轮渲染卸载重挂；遗漏则闭包过期。ref 两者兼顾。
  // （当前 keep=true 路径不读可变状态，实际不会出 bug，但这样写对未来改动稳健。）
  const showRunsRef = useRef(showRuns);
  showRunsRef.current = showRuns;
  useEffect(() => {
    if (!window.mjcode?.onScheduledChanged) return;
    const off = window.mjcode.onScheduledChanged(() => {
      load();
      if (expandedRuns?.taskId) showRunsRef.current(expandedRuns.taskId, true);
    });
    return off;
  }, [expandedRuns?.taskId]);

  const formCron = form.repeat === 'custom' ? form.schedule : (() => {
    const [h, m] = String(form.time || '09:00').split(':').map(Number);
    const r = REPEATS.find((x) => x.id === form.repeat);
    return r?.toCron ? r.toCron({ h: Number.isNaN(h) ? 9 : h, m: Number.isNaN(m) ? 0 : m }) : '';
  })();
  const formCronErr = formCron ? validateCron(formCron) : null;

  async function createTask() {
    if (!form.name.trim() || !form.prompt.trim()) {
      setError('任务名称与提示词必填');
      return;
    }
    if (formCronErr) { setError(`执行计划无效：${formCronErr}`); return; }
    try {
      await api.createScheduledTask({
        name: form.name.trim(),
        prompt: form.prompt,
        schedule: formCron,
        enabled: true,
        valid_until: form.validType === 'until' && form.validUntil ? form.validUntil : null,
      });
      setShowForm(false);
      setForm({ name: '', prompt: '', repeat: 'daily', time: '09:00', schedule: '0 9 * * *', validType: 'forever', validUntil: '' });
      setError('');
      setNotice('任务已创建并启用，到点将自动执行');
      load();
    } catch (err) {
      setError(`创建失败：${err.message}`);
    }
  }

  async function toggle(id, enabled) {
    await api.updateScheduledTask(id, { enabled: !enabled });
    load();
  }

  async function remove(id, name) {
    // A2：删除需确认
    const ok = await confirm({
      title: '删除定时任务',
      message: `确定删除定时任务「${name || id}」吗？其执行历史将一并删除。`,
      danger: true,
      confirmLabel: '删除',
    });
    if (!ok) return;
    await api.deleteScheduledTask(id);
    load();
  }

  async function runNow(id) {
    setBusyId(id);
    setRunResult(null);
    try {
      const r = await api.runScheduledTask(id);
      setRunResult({ taskId: id, ok: true, text: r.output || '（无输出）' });
    } catch (err) {
      setRunResult({ taskId: id, ok: false, text: err.message || '执行失败' });
    }
    setBusyId(null);
    load();
    if (expandedRuns?.taskId === id) showRuns(id);
  }

  async function showRuns(id, keep) {
    if (!keep && expandedRuns?.taskId === id) { setExpandedRuns(null); return; }
    try {
      // B1：记录 taskId，渲染时只在该任务的卡片内展开
      setExpandedRuns({ taskId: id, list: await api.scheduledTaskRuns(id) });
    } catch (err) {
      console.warn('[scheduled] 运行历史加载失败:', err);
      setExpandedRuns({ taskId: id, list: [] });
    }
  }

  const enabledCount = tasks.filter((t) => t.enabled).length;
  const filtered = tasks.filter((t) => (filter === 'all' ? true : filter === 'enabled' ? t.enabled : !t.enabled));

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold">定时任务</h2>
          <p className="text-text2 text-xs mt-1">到点自动执行提示词（本机直连所选模型），应用在前台时调度，执行记录完整留存</p>
        </div>
        <button onClick={() => { setShowForm(true); setError(''); }}
          className="h-8 inline-flex items-center justify-center gap-1.5 px-3.5 rounded-lg bg-accent text-white text-sm hover:opacity-90">
          <IconPlus size={14} /> 新建任务
        </button>
      </div>

      {/* 状态筛选（TRAE 同款：全部/已启用/已停用） */}
      <div className="flex items-center gap-1.5 mb-4">
        {[['all', `全部 (${tasks.length})`], ['enabled', `已启用 (${enabledCount})`], ['disabled', `已停用 (${tasks.length - enabledCount})`]].map(([id, label]) => (
          <button key={id} onClick={() => setFilter(id)}
            className={`h-7 inline-flex items-center px-3 rounded-full text-xs border ${filter === id ? 'border-accent text-accent' : 'border-border text-text2 hover:text-text'}`}>
            {label}
          </button>
        ))}
      </div>

      {error && <div className="mb-4"><InlineAlert type="error" onDismiss={() => setError('')}>{error}</InlineAlert></div>}
      {notice && <div className="mb-4"><InlineAlert type="info" onDismiss={() => setNotice('')}>{notice}</InlineAlert></div>}

      {/* 新建任务弹窗（TRAE 同款：名称 / 提示词 / 重复 / 时间 / 有效期） */}
      {showForm && (
        <div className="fixed inset-0 z-settings flex items-center justify-center bg-overlay" onClick={() => setShowForm(false)}>
          <div className="w-[560px] max-h-[86vh] overflow-y-auto bg-bg border border-border rounded-2xl p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold">新建定时任务</h3>
              <button onClick={() => setShowForm(false)} className="text-text2 hover:text-text"><IconX size={16} /></button>
            </div>

            <input placeholder="输入任务名称" value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full h-10 bg-bg border border-border rounded-xl px-3.5 text-sm mb-3 outline-none focus:border-accent" />
            <textarea placeholder="添加提示词（到点后 AI 将执行该指令并留存结果）" value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              className="w-full bg-bg border border-border rounded-xl px-3.5 py-3 text-sm mb-3 h-28 outline-none focus:border-accent" />

            {/* 重复 / 时间 / 有效期（TRAE 三联行） */}
            <div className="grid grid-cols-3 gap-2 mb-3">
              <select value={form.repeat} onChange={(e) => setForm({ ...form, repeat: e.target.value })}
                className="h-10 bg-bg border border-border rounded-xl px-2.5 text-sm outline-none focus:border-accent">
                {REPEATS.map((r) => <option key={r.id} value={r.id}>{`重复：${r.label}`}</option>)}
              </select>
              <select value={form.validType} onChange={(e) => setForm({ ...form, validType: e.target.value })}
                className="h-10 bg-bg border border-border rounded-xl px-2.5 text-sm outline-none focus:border-accent">
                <option value="forever">有效期：长期有效</option>
                <option value="until">有效期：截止日期</option>
              </select>
              <input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })}
                className="h-10 bg-bg border border-border rounded-xl px-2.5 text-sm outline-none focus:border-accent" />
            </div>
            {form.validType === 'until' && (
              <input type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
                className="w-full h-10 bg-bg border border-border rounded-xl px-3.5 text-sm mb-3 outline-none focus:border-accent" />
            )}
            {form.repeat === 'custom' && (
              <input placeholder="Cron 表达式（5 字段：分 时 日 月 周，如 0 9 * * *）" value={form.schedule}
                onChange={(e) => setForm({ ...form, schedule: e.target.value })}
                className="w-full h-10 bg-bg border border-border rounded-xl px-3.5 text-sm font-mono mb-2 outline-none focus:border-accent" />
            )}

            {formCronErr ? (
              <p className="text-xs text-danger mb-1">{formCronErr}</p>
            ) : (
              <p className="text-xs text-text2 mb-1">
                执行计划：{form.repeat === 'custom' ? form.schedule : humanSchedule(formCron)}
                {formCron && (() => { const d = nextCronRun(formCron); return d ? ` · 下次运行 ${d.toLocaleString('zh-CN')}` : ''; })()}
                {form.validType === 'until' && form.validUntil && ` · 截止 ${form.validUntil}`}
              </p>
            )}

            <div className="flex justify-end gap-3 mt-5">
              <button onClick={() => setShowForm(false)}
                className="h-9 inline-flex items-center justify-center px-4 rounded-xl text-sm border border-border hover:bg-hover">取消</button>
              <button onClick={createTask}
                className="h-9 inline-flex items-center justify-center px-4 rounded-xl bg-accent text-white text-sm hover:opacity-90">确定</button>
            </div>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="text-text2 text-sm text-center py-10">
          {tasks.length === 0 ? '暂无定时任务，点击右上角「新建任务」创建' : '当前筛选下暂无任务'}
        </p>
      ) : filtered.map((t) => {
        const meta = STATUS_META[t.last_status];
        return (
          <div key={t.id} className="bg-surface border border-border rounded-xl p-4 mb-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium flex items-center gap-2">
                  <span className="truncate">{t.name}</span>
                  {!t.enabled && <span className="text-xs text-text2 shrink-0">已暂停</span>}
                  {meta && <span className={`text-xs shrink-0 ${meta.cls}`}>上次：{meta.label}</span>}
                  {t.valid_until && (
                    <span className="text-xs text-text2 shrink-0" title="有效期截止">至 {t.valid_until}</span>
                  )}
                </div>
                <div className="text-xs text-text2 mt-1 line-clamp-2">{t.prompt.slice(0, 100)}</div>
                <div className="text-xs text-text2 mt-1 flex items-center gap-1">
                  <IconClock size={12} /> {humanSchedule(t.schedule)}
                  <span className="font-mono opacity-60">（{t.schedule}）</span>
                  {t.last_run_at && <span className="ml-2">· 上次运行 {new Date(t.last_run_at).toLocaleString('zh-CN')}</span>}
                </div>
                {t.last_result && (
                  <div className="text-xs text-text2 mt-2 bg-bg rounded-lg p-2 max-h-24 overflow-y-auto whitespace-pre-wrap">
                    {String(t.last_result).slice(0, 400)}
                  </div>
                )}
                {runResult?.taskId === t.id && (
                  <div className={`text-xs mt-2 rounded-lg p-2 max-h-40 overflow-y-auto whitespace-pre-wrap ${runResult.ok ? 'bg-bg text-text2' : 'bg-danger-bg text-danger'}`}>
                    {runResult.text.slice(0, 800)}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => runNow(t.id)} disabled={busyId === t.id}
                  className="h-7 inline-flex items-center justify-center px-2.5 rounded-lg border border-border hover:bg-hover text-xs disabled:opacity-50">
                  {busyId === t.id ? '执行中…' : '立即运行'}
                </button>
                <button onClick={() => showRuns(t.id)}
                  className="h-7 inline-flex items-center justify-center px-2.5 rounded-lg border border-border hover:bg-hover text-xs">运行记录</button>
                <Switch on={!!t.enabled} onChange={() => toggle(t.id, t.enabled)} />
                <button onClick={() => remove(t.id, t.name)} className="text-text2 hover:text-danger" title="删除"><IconX size={14} /></button>
              </div>
            </div>

            {expandedRuns?.taskId === t.id && Array.isArray(expandedRuns.list) && (
              <div className="mt-3 border-t border-border pt-3">
                {expandedRuns.list.length === 0 ? (
                  <p className="text-text2 text-xs">暂无运行记录</p>
                ) : expandedRuns.list.map((r) => {
                  const rm = STATUS_META[r.status];
                  return (
                    <div key={r.id} className="text-xs py-2 border-b border-border last:border-0">
                      <div className="flex items-center gap-2">
                        {r.status === 'success' ? <IconCheck size={12} className="text-success" /> : <IconX size={12} className={r.status === 'failed' ? 'text-danger' : 'text-text2'} />}
                        <span className={rm?.cls || 'text-text2'}>{rm?.label || r.status}</span>
                        <span className="text-text2">{new Date(r.started_at).toLocaleString('zh-CN')}</span>
                        {(r.trigger === 'scheduled') && <span className="text-text2">· 定时触发</span>}
                        {r.duration_ms > 0 && <span className="text-text2">· 耗时 {(r.duration_ms / 1000).toFixed(1)}s</span>}
                        {/* P0-D：Agent 通道标记 + 工具调用数（可观测：区分「跑了 Agent」与「只说了句话」） */}
                        {r.channel === 'agent' && <span className="text-text2">· Agent{r.tools > 0 ? ` ${r.tools} 次工具调用` : ''}</span>}
                      </div>
                      {(r.output || r.error) && (
                        <div className="text-text2 mt-1 whitespace-pre-wrap max-h-20 overflow-y-auto">{(r.output || r.error).slice(0, 300)}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

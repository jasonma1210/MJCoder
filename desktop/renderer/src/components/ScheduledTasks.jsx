import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import InlineAlert from './InlineAlert';
import { confirm } from './feedback';
import { IconCheck, IconClock, IconPlus, IconX } from './icons';
import Switch from './ui/Switch';
import Modal from './ui/Modal';
import { useI18n, tGlobal } from '../i18n';

// labelKey 而非 label：顶层常量不持有求值结果，渲染时经 t() 取文案
// P0-8a：missed=应用未运行期间错过计划执行（主进程启动扫描标记，绝不静默）
const STATUS_META = {
  success: { labelKey: 'scheduled.statusSuccess', cls: 'text-success' },
  failed: { labelKey: 'scheduled.statusFailed', cls: 'text-danger' },
  running: { labelKey: 'scheduled.statusRunning', cls: 'text-accent' },
  missed: { labelKey: 'scheduled.statusMissed', cls: 'text-danger' },
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

// 语法校验：返回错误文案或 null（非 hook 纯函数：调用时经 tGlobal 求值）
function validateCron(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) return tGlobal('scheduled.cronFiveFields');
  if (!fields.every(cronFieldOk)) return tGlobal('scheduled.cronFieldChars');
  if (Number(fields[0]) > 59 || Number(fields[1]) > 23) return tGlobal('scheduled.cronMinuteHour');
  if (Number(fields[2]) > 31 || Number(fields[3]) > 12) return tGlobal('scheduled.cronDayMonth');
  if (Number(fields[4]) > 7) return tGlobal('scheduled.cronDow');
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

// 星期名 i18n key（下标与 JS getDay 对齐：0=周日）
const DOW_KEYS = ['daySun', 'dayMon', 'dayTue', 'dayWed', 'dayThu', 'dayFri', 'daySat'];

// cron → 人话（TRAE 卡片同款「每天 10:00」样式；无法归约时回退原表达式）
// 非 hook 纯函数：调用时经 tGlobal 求值（渲染期每次调用，切语言即时生效）
function humanSchedule(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return expr;
  const [m, h, dom, mon, dow] = f;
  const time = /^\d+$/.test(h) && /^\d+$/.test(m)
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` : null;
  if (dom === '*' && mon === '*' && dow === '*') return time ? tGlobal('scheduled.everyDayTime', { time }) : tGlobal('scheduled.everyDayExpr', { expr });
  if (dom === '*' && mon === '*' && dow === '1-5') return time ? tGlobal('scheduled.weekdaysTime', { time }) : tGlobal('scheduled.weekdaysExpr', { expr });
  if (dom === '*' && mon === '*' && /^\d$/.test(dow)) {
    return time ? tGlobal('scheduled.weeklyDay', { day: tGlobal(`scheduled.${DOW_KEYS[Number(dow) % 7]}`), time }) : expr;
  }
  return expr;
}

// labelKey 而非 label：顶层常量不持有求值结果，渲染时经 t() 取文案
const REPEATS = [
  { id: 'daily', labelKey: 'scheduled.repeatDaily', toCron: (t) => `${t.m} ${t.h} * * *` },
  { id: 'weekday', labelKey: 'scheduled.repeatWeekday', toCron: (t) => `${t.m} ${t.h} * * 1-5` },
  { id: 'weekly', labelKey: 'scheduled.repeatWeekly', toCron: (t) => `${t.m} ${t.h} * * 1` },
  { id: 'custom', labelKey: 'scheduled.repeatCustom', toCron: null },
];

// 小开关（TRAE 卡片右侧同款）：视觉与语义统一由 ui/Switch 承载（P1-9）

export default function ScheduledTasks() {
  const { t } = useI18n();
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
  // P0-8c：开机自启（主进程 app.setLoginItemSettings，偏好落 localStore）。
  // 桥接 IPC（app:autoLaunchGet/Set + preload）未就绪时 autoLaunchSupported=false，
  // 开关整体隐藏——不做「看起来能切、实际不生效」的假开关（设置项必须真的被消费）。
  const [autoLaunchSupported] = useState(() => typeof window.mjcode?.autoLaunchGet === 'function');
  const [autoLaunch, setAutoLaunch] = useState(false);

  async function load() {
    try {
      setTasks(await api.scheduledTasks());
    } catch (err) {
      console.warn('[scheduled] failed to load task list:', err);
      setError(t('scheduled.loadFailed'));
    }
  }

  useEffect(() => { load(); }, []);

  // P0-8c：开机自启现状读取（主进程侧为唯一事实源：localStore preference + 系统登录项）
  useEffect(() => {
    if (!autoLaunchSupported) return;
    let alive = true;
    window.mjcode.autoLaunchGet()
      .then((r) => { if (alive) setAutoLaunch(!!r?.enabled); })
      .catch((err) => console.warn('[scheduled] failed to read auto-launch state:', err));
    return () => { alive = false; };
  }, [autoLaunchSupported]);

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
      setError(t('scheduled.namePromptRequired'));
      return;
    }
    if (formCronErr) { setError(t('scheduled.invalidSchedule', { err: formCronErr })); return; }
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
      setNotice(t('scheduled.createdNotice'));
      load();
    } catch (err) {
      setError(t('scheduled.createFailed', { msg: err.message }));
    }
  }

  async function toggle(id, enabled) {
    await api.updateScheduledTask(id, { enabled: !enabled });
    load();
  }

  // P0-8c：开机自启切换（乐观更新，失败回滚并明示；不静默丢失用户意图）
  async function toggleAutoLaunch() {
    const next = !autoLaunch;
    setAutoLaunch(next);
    try {
      const r = await window.mjcode.autoLaunchSet({ enabled: next });
      if (r && r.ok === false) throw new Error(r.error || t('runtime.unknownError'));
    } catch (err) {
      setAutoLaunch(!next);
      console.warn('[scheduled] failed to set auto-launch:', err);
      setError(t('scheduled.autoLaunchFailed', { msg: err.message }));
    }
  }

  async function remove(id, name) {
    // A2：删除需确认
    const ok = await confirm({
      title: t('scheduled.deleteTitle'),
      message: t('scheduled.deleteMessage', { name: name || id }),
      danger: true,
      confirmLabel: t('scheduled.delete'),
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
      // 此前这里写死 ok:true —— 任务明明判失败（r.ok=false）也用成功色渲染，
      // 用户看到「成功了，但内容是做不到」。现在如实透传执行结果。
      setRunResult({
        taskId: id,
        ok: !!r?.ok,
        text: (r?.ok ? r?.output : (r?.error || r?.output)) || t('scheduled.noOutput'),
      });
    } catch (err) {
      setRunResult({ taskId: id, ok: false, text: err.message || t('scheduled.runFailed') });
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
      console.warn('[scheduled] failed to load run history:', err);
      setExpandedRuns({ taskId: id, list: [] });
    }
  }

  const enabledCount = tasks.filter((task) => task.enabled).length;
  const filtered = tasks.filter((task) => (filter === 'all' ? true : filter === 'enabled' ? task.enabled : !task.enabled));

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold">{t('scheduled.title')}</h2>
          <p className="text-text2 text-xs mt-1">{t('scheduled.subtitle')}</p>
        </div>
        <button onClick={() => { setShowForm(true); setError(''); }}
          className="h-8 inline-flex items-center justify-center gap-1.5 px-3.5 rounded-lg bg-accent-solid text-on-accent text-sm hover:brightness-110">
          <IconPlus size={14} /> {t('scheduled.newTask')}
        </button>
      </div>

      {/* 状态筛选（TRAE 同款：全部/已启用/已停用） */}
      <div className="flex items-center gap-1.5 mb-4">
        {[['all', t('scheduled.filterAll', { n: tasks.length })], ['enabled', t('scheduled.filterEnabled', { n: enabledCount })], ['disabled', t('scheduled.filterDisabled', { n: tasks.length - enabledCount })]].map(([id, label]) => (
          <button key={id} onClick={() => setFilter(id)}
            className={`h-7 inline-flex items-center px-3 rounded-full text-xs border ${filter === id ? 'border-accent text-accent' : 'border-border text-text2 hover:text-text'}`}>
            {label}
          </button>
        ))}
      </div>

      {error && <div className="mb-4"><InlineAlert type="error" onDismiss={() => setError('')}>{error}</InlineAlert></div>}
      {notice && <div className="mb-4"><InlineAlert type="info" onDismiss={() => setNotice('')}>{notice}</InlineAlert></div>}

      {/* P0-8c：开机自动运行（定时任务错过即永久丢失的根因之一是应用没开；自启 + 启动补跑扫描共同闭环） */}
      {autoLaunchSupported && (
        <div className="flex items-center justify-between bg-surface border border-border rounded-xl px-4 py-3 mb-4">
          <div className="min-w-0">
            <div className="text-sm font-medium">{t('scheduled.autoLaunch')}</div>
            <div className="text-xs text-text2 mt-1">{t('scheduled.autoLaunchHint')}</div>
          </div>
          <Switch checked={!!autoLaunch} onChange={() => toggleAutoLaunch()} label={t('scheduled.autoLaunch')} />
        </div>
      )}

      {/* 新建任务弹窗（TRAE 同款：名称 / 提示词 / 重复 / 时间 / 有效期）
          外壳交给 ui/Modal frameless：dialog 语义 + 焦点陷阱 + Esc + 关闭归还焦点，
          面板的尺寸/底色/圆角仍是下面这层（视觉零改动） */}
      {showForm && (
        <Modal open onClose={() => setShowForm(false)} frameless ariaLabel={t('scheduled.formTitle')}>
          <div className="w-[min(560px,calc(100vw-2rem))] max-h-[86vh] overflow-y-auto bg-surface border border-border rounded-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold">{t('scheduled.formTitle')}</h3>
              <button onClick={() => setShowForm(false)} className="text-text2 hover:text-text"><IconX size={16} /></button>
            </div>

            <input placeholder={t('scheduled.namePlaceholder')} value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full h-10 bg-input border border-border rounded-xl px-3.5 text-sm mb-3 outline-none focus:border-accent" />
            <textarea placeholder={t('scheduled.promptPlaceholder')} value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              className="w-full bg-input border border-border rounded-xl px-3.5 py-3 text-sm mb-3 h-28 outline-none focus:border-accent" />

            {/* 重复 / 时间 / 有效期（TRAE 三联行） */}
            <div className="grid grid-cols-3 gap-2 mb-3">
              <select value={form.repeat} onChange={(e) => setForm({ ...form, repeat: e.target.value })}
                className="h-10 bg-input border border-border rounded-xl px-2.5 text-sm outline-none focus:border-accent">
                {REPEATS.map((r) => <option key={r.id} value={r.id}>{t('scheduled.repeatLabel', { label: t(r.labelKey) })}</option>)}
              </select>
              <select value={form.validType} onChange={(e) => setForm({ ...form, validType: e.target.value })}
                className="h-10 bg-input border border-border rounded-xl px-2.5 text-sm outline-none focus:border-accent">
                <option value="forever">{t('scheduled.validForever')}</option>
                <option value="until">{t('scheduled.validUntilType')}</option>
              </select>
              <input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })}
                className="h-10 bg-input border border-border rounded-xl px-2.5 text-sm outline-none focus:border-accent" />
            </div>
            {form.validType === 'until' && (
              <input type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
                className="w-full h-10 bg-input border border-border rounded-xl px-3.5 text-sm mb-3 outline-none focus:border-accent" />
            )}
            {form.repeat === 'custom' && (
              <input placeholder={t('scheduled.cronPlaceholder')} value={form.schedule}
                onChange={(e) => setForm({ ...form, schedule: e.target.value })}
                className="w-full h-10 bg-input border border-border rounded-xl px-3.5 text-sm font-mono mb-2 outline-none focus:border-accent" />
            )}

            {formCronErr ? (
              <p className="text-xs text-danger mb-1">{formCronErr}</p>
            ) : (
              <p className="text-xs text-text2 mb-1">
                {t('scheduled.scheduleLabel', { value: form.repeat === 'custom' ? form.schedule : humanSchedule(formCron) })}
                {formCron && (() => { const d = nextCronRun(formCron); return d ? t('scheduled.nextRun', { time: d.toLocaleString('zh-CN') }) : ''; })()}
                {form.validType === 'until' && form.validUntil && t('scheduled.untilDate', { date: form.validUntil })}
              </p>
            )}

            <div className="flex justify-end gap-3 mt-5">
              <button onClick={() => setShowForm(false)}
                className="h-9 inline-flex items-center justify-center px-4 rounded-xl text-sm border border-border hover:bg-hover">{t('scheduled.cancel')}</button>
              <button onClick={createTask}
                className="h-9 inline-flex items-center justify-center px-4 rounded-xl bg-accent-solid text-on-accent text-sm hover:brightness-110">{t('scheduled.confirm')}</button>
            </div>
          </div>
        </Modal>
      )}

      {filtered.length === 0 ? (
        <p className="text-text2 text-sm text-center py-10">
          {tasks.length === 0 ? t('scheduled.emptyTasks') : t('scheduled.emptyFiltered')}
        </p>
      ) : filtered.map((task) => {
        const meta = STATUS_META[task.last_status];
        return (
          <div key={task.id} className="bg-surface border border-border rounded-xl p-4 mb-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium flex items-center gap-2">
                  <span className="truncate">{task.name}</span>
                  {!task.enabled && <span className="text-xs text-text2 shrink-0">{t('scheduled.paused')}</span>}
                  {meta && <span className={`text-xs shrink-0 ${meta.cls}`}>{t('scheduled.lastStatus', { label: t(meta.labelKey) })}</span>}
                  {task.valid_until && (
                    <span className="text-xs text-text2 shrink-0" title={t('scheduled.validUntilTitle')}>{t('scheduled.untilPrefix', { date: task.valid_until })}</span>
                  )}
                </div>
                <div className="text-xs text-text2 mt-1 line-clamp-2">{task.prompt.slice(0, 100)}</div>
                <div className="text-xs text-text2 mt-1 flex items-center gap-1">
                  <IconClock size={12} /> {humanSchedule(task.schedule)}
                  <span className="font-mono opacity-60">{t('scheduled.cronParens', { cron: task.schedule })}</span>
                  {task.last_run_at && <span className="ml-2">{t('scheduled.lastRun', { time: new Date(task.last_run_at).toLocaleString('zh-CN') })}</span>}
                </div>
                {/* 结果只渲染一处：刚跑完用 runResult（带成功/失败配色），否则回落到 last_result。
                    此前两个条件独立成立，同一次运行的结果会在卡片里叠成两个框（用户实测）。 */}
                {runResult?.taskId === task.id ? (
                  <div className={`text-xs mt-2 rounded-lg p-2 max-h-40 overflow-y-auto whitespace-pre-wrap ${runResult.ok ? 'bg-input text-text2' : 'bg-danger-bg text-danger'}`}>
                    {runResult.text.slice(0, 800)}
                  </div>
                ) : task.last_result && (
                  <div className="text-xs text-text2 mt-2 bg-input rounded-lg p-2 max-h-24 overflow-y-auto whitespace-pre-wrap">
                    {String(task.last_result).slice(0, 400)}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => runNow(task.id)} disabled={busyId === task.id}
                  className="h-7 inline-flex items-center justify-center px-2.5 rounded-lg border border-border hover:bg-hover text-xs disabled:opacity-50">
                  {busyId === task.id ? t('scheduled.runningNow') : t('scheduled.runNow')}
                </button>
                <button onClick={() => showRuns(task.id)}
                  className="h-7 inline-flex items-center justify-center px-2.5 rounded-lg border border-border hover:bg-hover text-xs">{t('scheduled.runs')}</button>
                <Switch checked={!!task.enabled} onChange={() => toggle(task.id, task.enabled)}
                  label={t('settings.enableToggle', { name: String(task.name || task.id || '') })} />
                <button onClick={() => remove(task.id, task.name)} className="text-text2 hover:text-danger" title={t('scheduled.delete')}><IconX size={14} /></button>
              </div>
            </div>

            {expandedRuns?.taskId === task.id && Array.isArray(expandedRuns.list) && (
              <div className="mt-3 border-t border-border pt-3">
                {expandedRuns.list.length === 0 ? (
                  <p className="text-text2 text-xs">{t('scheduled.noRuns')}</p>
                ) : expandedRuns.list.map((r) => {
                  const rm = STATUS_META[r.status];
                  return (
                    <div key={r.id} className="text-xs py-2 border-b border-border last:border-0">
                      <div className="flex items-center gap-2">
                        {r.status === 'success' ? <IconCheck size={12} className="text-success" /> : <IconX size={12} className={r.status === 'failed' ? 'text-danger' : 'text-text2'} />}
                        <span className={rm?.cls || 'text-text2'}>{rm ? t(rm.labelKey) : r.status}</span>
                        <span className="text-text2">{new Date(r.started_at).toLocaleString('zh-CN')}</span>
                        {(r.trigger === 'scheduled') && <span className="text-text2">{t('scheduled.scheduledTrigger')}</span>}
                        {/* P0-8a：补跑标记——应用未运行期间到期，启动时补跑一次（与定时触发区分，避免误导） */}
                        {(r.trigger === 'catchup') && <span className="text-text2">{t('scheduled.catchupTrigger')}</span>}
                        {r.duration_ms > 0 && <span className="text-text2">{t('scheduled.duration', { n: (r.duration_ms / 1000).toFixed(1) })}</span>}
                        {/* P0-D：Agent 通道标记 + 工具调用数（可观测：区分「跑了 Agent」与「只说了句话」） */}
                        {r.channel === 'agent' && <span className="text-text2">{r.tools > 0 ? t('scheduled.agentToolCalls', { n: r.tools }) : t('scheduled.agentTag')}</span>}
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

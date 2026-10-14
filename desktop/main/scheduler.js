// 本地定时任务调度器（桌面端，离线可用）
// 设计：
// - 任务与运行记录持久化在 userData/scheduled-tasks.json（随 app 启动加载）
// - 每 20s 轮询 cron（5 字段：分 时 日 月 周），分钟粒度幂等（同分钟只触发一次）
// - P0-D：执行通道为 Agent（agent-core 工具循环 + 审批分级 + 沙箱 + 轮次预算），
//   未提供 runAgentTask 时回落单轮对话（chatOnce，兼容旧调用方）
// - 单任务墙钟超时（默认 10 分钟，startScheduler 可注入 taskTimeoutMs）防无人值守僵死
// - 有效期 valid_until（YYYY-MM-DD）过期后自动跳过；任务执行中不重复触发
// - 与服务端 /scheduled-tasks 同构：list 返回任务数组，runs 返回执行历史数组
const path = require('path');
const fs = require('fs');
const { app, ipcMain } = require('electron');

const STORE_FILE = () => path.join(app.getPath('userData'), 'scheduled-tasks.json');
const MAX_RUNS = 200;          // 全局运行历史上限
const MAX_RUNS_PER_TASK = 50;  // 单任务保留条数
const TICK_MS = 20 * 1000;
const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000; // 单任务墙钟上限

let store = { tasks: [], runs: [] };
let execCtx = { chatOnce: null, runAgentTask: null, model: null };
let timer = null;
let notifying = null;
let taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS;
const lastFired = new Map(); // taskId -> 'YYYY-M-D H:m'（同分钟幂等）
const running = new Set();   // 执行中的 taskId

// ── 持久化 ──
function loadStore() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_FILE(), 'utf8'));
    if (j && Array.isArray(j.tasks)) {
      store = { tasks: j.tasks, runs: Array.isArray(j.runs) ? j.runs : [] };
    }
  } catch (e) {
    store = { tasks: [], runs: [] }; // 首次启动 / 文件损坏兜底
  }
}

function persist() {
  try {
    fs.writeFileSync(STORE_FILE(), JSON.stringify(store, null, 2));
  } catch (e) {
    console.error('[scheduled] 持久化失败:', e.message);
  }
}

// ── cron 匹配（与渲染层 validateCron 同语义；周字段 0=周日）──
const FIELD_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function fieldOk(raw, [min, max]) {
  if (raw === '*' || raw === '') return true;
  return raw.split(',').every((part) => {
    const [rng, stepRaw] = String(part).split('/');
    const step = stepRaw ? parseInt(stepRaw, 10) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    if (rng === '*') return true;
    if (rng.includes('-')) {
      const [a, b] = rng.split('-').map(Number);
      return Number.isInteger(a) && Number.isInteger(b) && a >= min && a <= max && b >= min && b <= max && a <= b;
    }
    const v = Number(rng);
    return Number.isInteger(v) && v >= min && v <= max;
  });
}

function cronValid(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return false;
  return f.every((raw, i) => fieldOk(raw, FIELD_RANGES[i]));
}

function fieldMatches(raw, value) {
  return String(raw).split(',').some((part) => {
    const [rng, stepRaw] = part.split('/');
    const step = stepRaw ? parseInt(stepRaw, 10) || 1 : 1;
    if (rng === '*' || rng === '') return value % step === 0;
    if (rng.includes('-')) {
      const [a, b] = rng.split('-').map(Number);
      return value >= a && value <= b && (value - a) % step === 0;
    }
    const v = Number(rng);
    if (Number.isNaN(v)) return false;
    return step === 1 ? value === v : value >= v && (value - v) % step === 0;
  });
}

function cronMatches(expr, d) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return false;
  return fieldMatches(f[0], d.getMinutes())
    && fieldMatches(f[1], d.getHours())
    && fieldMatches(f[2], d.getDate())
    && fieldMatches(f[3], d.getMonth() + 1)
    && fieldMatches(f[4], d.getDay());
}

// ── 执行 ──
async function runTask(id, trigger = 'manual') {
  const t = store.tasks.find((x) => x.id === id);
  if (!t) return { ok: false, error: '任务不存在' };
  if (running.has(id)) return { ok: false, error: '任务正在执行中' };
  const useAgent = typeof execCtx.runAgentTask === 'function';
  if (!useAgent && typeof execCtx.chatOnce !== 'function') {
    return { ok: false, error: '执行通道未就绪（模型凭证未加载）' };
  }
  const model = execCtx.model;
  if (!model || !model.model) {
    return { ok: false, error: '未配置执行模型：请在任意会话中选择模型（定时任务复用会话模型与凭证）' };
  }

  running.add(id);
  const started = Date.now();
  const run = {
    id: `r-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    task_id: id,
    trigger,
    status: 'running',
    started_at: new Date().toISOString(),
    finished_at: null,
    duration_ms: 0,
    output: '',
    error: '',
    channel: useAgent ? 'agent' : 'chat', // P0-D：执行通道可观测
    tools: 0,                              // Agent 通道的工具调用计数
    tokens: null,                          // Agent 通道的 token 用量 {prompt_tokens, completion_tokens}
  };
  store.runs.unshift(run);
  store.runs = store.runs.slice(0, MAX_RUNS);
  persist();
  notify();

  // 无人值守墙钟超时：到点 abort（runAgent 的 signal 会收敛当前轮）
  const ctl = new AbortController();
  const timeoutTimer = setTimeout(() => ctl.abort(), taskTimeoutMs);
  try {
    if (useAgent) {
      const r = await execCtx.runAgentTask({ prompt: t.prompt, model, signal: ctl.signal });
      run.status = 'success';
      run.output = String(r?.output || '').slice(0, 20000);
      run.tools = Number(r?.toolCalls) || 0;
      run.tokens = r?.usage || null;
    } else {
      const out = await execCtx.chatOnce({
        messages: [
          { role: 'system', content: '你是定时任务执行器：直接完成任务提示词中的要求并输出精炼结果，不要反问、不要输出无关寒暄。' },
          { role: 'user', content: String(t.prompt || '') },
        ],
      }, model);
      run.status = 'success';
      run.output = String(out || '').slice(0, 20000);
    }
  } catch (err) {
    run.status = 'failed';
    // 无人值守无用户中止入口，signal.aborted 即墙钟超时
    run.error = ctl.signal.aborted
      ? `执行超时（墙钟上限 ${Math.round(taskTimeoutMs / 60000)} 分钟），已中止`
      : String(err?.message || err).slice(0, 2000);
  } finally {
    clearTimeout(timeoutTimer);
  }
  run.finished_at = new Date().toISOString();
  run.duration_ms = Date.now() - started;
  running.delete(id);
  // 每任务历史上限
  const same = store.runs.filter((r) => r.task_id === id);
  if (same.length > MAX_RUNS_PER_TASK) {
    const drop = new Set(same.slice(MAX_RUNS_PER_TASK).map((r) => r.id));
    store.runs = store.runs.filter((r) => !drop.has(r.id));
  }
  persist();
  notify();
  return { ok: run.status === 'success', output: run.output, error: run.error };
}

function tick() {
  const now = new Date();
  const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
  for (const t of store.tasks) {
    if (!t.enabled) continue;
    if (t.valid_until && now.getTime() > new Date(`${t.valid_until}T23:59:59`).getTime()) continue;
    if (!cronValid(t.schedule) || !cronMatches(t.schedule, now)) continue;
    if (lastFired.get(t.id) === key) continue;
    lastFired.set(t.id, key);
    runTask(t.id, 'scheduled').catch((e) => console.error('[scheduled] 触发失败:', e.message));
  }
}

function notify() {
  if (typeof notifying !== 'function') return;
  try { notifying({ tasks: store.tasks, runs: store.runs }); } catch { /* 通知失败不影响调度 */ }
}

// ── 对外 API ──
// startScheduler 对执行上下文是权威定义：未提供的通道显式置空（不保留上一次的注入），
// 避免调用方换了通道组合后旧通道仍然生效
function startScheduler({ chatOnce, runAgentTask, notify: n, taskTimeoutMs: tt } = {}) {
  loadStore();
  execCtx.chatOnce = typeof chatOnce === 'function' ? chatOnce : null;
  execCtx.runAgentTask = typeof runAgentTask === 'function' ? runAgentTask : null;
  if (Number(tt) > 0) taskTimeoutMs = Number(tt);
  notifying = n || null;
  if (timer) clearInterval(timer);
  timer = setInterval(tick, TICK_MS);
  const enabled = store.tasks.filter((t) => t.enabled).length;
  const channel = execCtx.runAgentTask ? 'agent' : 'chat';
  console.log(`[scheduled] 调度器已启动：${store.tasks.length} 个任务（${enabled} 启用），执行通道=${channel}`);
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

function getModel() { return execCtx.model; }
function setModel(model) { execCtx.model = model || null; }

function registerIpc() {
  ipcMain.handle('scheduled:list', async () => ({ ok: true, tasks: store.tasks, runs: store.runs }));
  ipcMain.handle('scheduled:save', async (_, p = {}) => {
    const name = String(p.name || '').trim();
    const prompt = String(p.prompt || '');
    const schedule = String(p.schedule || '').trim();
    if (!name || !prompt || !schedule) return { ok: false, error: '任务名称、提示词与 Cron 表达式必填' };
    if (!cronValid(schedule)) return { ok: false, error: 'Cron 表达式无效（5 字段：分 时 日 月 周）' };
    const validUntil = p.valid_until ? String(p.valid_until).slice(0, 10) : null;
    if (p.id) {
      const t = store.tasks.find((x) => x.id === p.id);
      if (!t) return { ok: false, error: '任务不存在' };
      Object.assign(t, { name, prompt, schedule, enabled: p.enabled !== false, valid_until: validUntil });
      persist();
      return { ok: true, task: t };
    }
    const t = {
      id: `t-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
      name, prompt, schedule,
      enabled: p.enabled !== false,
      valid_until: validUntil,
      created_at: new Date().toISOString(),
    };
    store.tasks.unshift(t);
    persist();
    notify();
    return { ok: true, task: t };
  });
  ipcMain.handle('scheduled:delete', async (_, { id } = {}) => {
    store.tasks = store.tasks.filter((t) => t.id !== id);
    store.runs = store.runs.filter((r) => r.task_id !== id);
    running.delete(id);
    persist();
    notify();
    return { ok: true };
  });
  ipcMain.handle('scheduled:run', async (_, { id } = {}) => runTask(id, 'manual'));
  ipcMain.handle('scheduled:runs', async (_, { id } = {}) => ({
    ok: true,
    runs: store.runs.filter((r) => r.task_id === id).slice(0, MAX_RUNS_PER_TASK),
  }));
  ipcMain.handle('scheduled:setModel', async (_, model = null) => {
    setModel(model);
    return { ok: true };
  });
}

module.exports = {
  startScheduler, stopScheduler, registerIpc, getModel, setModel,
  cronValid, cronMatches, runTask,
};

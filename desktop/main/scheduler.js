// 本地定时任务调度器（桌面端，离线可用）
// 设计：
// - 任务与运行记录持久化在 userData/scheduled-tasks.json（随 app 启动加载）
// - 每 20s 轮询 cron（5 字段：分 时 日 月 周），分钟粒度幂等（同分钟只触发一次）
// - P0-D：执行通道为 Agent（agent-core 工具循环 + 审批分级 + 沙箱 + 轮次预算），
//   未提供 runAgentTask 时回落单轮对话（chatOnce，兼容旧调用方）
// - 单任务墙钟超时（默认 10 分钟，startScheduler 可注入 taskTimeoutMs）防无人值守僵死
// - 有效期 valid_until（YYYY-MM-DD）过期后自动跳过；任务执行中不重复触发
// - P0-8a：上次触发时刻 last_fired 随 store 持久化（原内存 Map 重启即丢失）；启动时扫描
//   [last_fired, now] 区间，宽限窗口内（与今天同日）补跑一次，否则标记 missed + last_status，
//   绝不静默；回放窗口上限 7 天，超长缺失只标记不补跑
// - P0-8b：runTask 收尾把 status/last_run_at/last_result 写回任务对象（UI 卡片直读，
//   此前主进程从不写入这三个字段）
// - 与服务端 /scheduled-tasks 同构：list 返回任务数组，runs 返回执行历史数组
const path = require('path');
const fs = require('fs');
const { app, ipcMain } = require('electron');
const { writeFileDurable } = require('./data/durableWrite');
const scheduledOutput = require('./scheduledOutput');
const guard = require('./ipc/payloadGuard');

const STORE_FILE = () => path.join(app.getPath('userData'), 'scheduled-tasks.json');
// 归档根目录：Documents（应用外可查阅）。取不到时返回空串，归档会被跳过而不是抛。
function documentsDir() {
  try { return app.getPath('documents') || ''; } catch { return ''; }
}
const MAX_RUNS = 200;          // 全局运行历史上限
const MAX_RUNS_PER_TASK = 50;  // 单任务保留条数
const TICK_MS = 20 * 1000;
const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000; // 单任务墙钟上限
// P0-8a：补跑回放窗口上限（7 天）。应用数周未开时不做全量回放：只按窗口内实际到期的
// 计划执行标记 missed，超长缺失不补跑（补跑数天前的任务没有意义，只是制造误导性执行记录）。
const SCAN_WINDOW_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const LAST_RESULT_MAX = 500;   // P0-8b：任务对象上 last_result 的截断长度（运行记录内 output 仍为 20000）

let store = { tasks: [], runs: [] };
let execCtx = { chatOnce: null, runAgentTask: null, model: null };
let timer = null;
let notifying = null;
let taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS;
const running = new Set();   // 执行中的 taskId

// ── 持久化 ──
// P0-持久化（2026-10-16）修复两处：
//   ① persist() 此前是裸 writeFileSync（无 tmp+rename、无 fsync）。崩溃时序不正会让
//      文件半写，下次启动 JSON.parse 失败 → 用户全部定时任务无声消失。
//   ② loadStore() 此前把「文件损坏」与「首次启动」当同一回事，catch 里一律
//      store = { tasks: [], runs: [] } 且不留任何痕迹——用户永远不知道自己丢了定时任务。
//      现区分 ENOENT（正常首次）与解析失败（损坏），损坏时保留副本 + 明示。
function loadStore() {
  const file = STORE_FILE();
  if (!fs.existsSync(file)) {
    store = { tasks: [], runs: [] }; // 正常首次启动，无历史
    return;
  }
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || !Array.isArray(j.tasks)) {
      throw new Error('结构非法：缺少 tasks 数组');
    }
    store = { tasks: j.tasks, runs: Array.isArray(j.runs) ? j.runs : [] };
  } catch (e) {
    // 损坏：保留副本供人工抢救（这是唯一能找回用户数据的东西），并显著告警
    const kept = `${file}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(file, kept); } catch { /* 保留失败不阻断，但下面会说明 */ }
    console.error(`[scheduled] 定时任务文件损坏：${e.message}；已保留副本 ${kept}，本次启动定时任务为空`);
    store = { tasks: [], runs: [] };
  }
}

function persist() {
  const file = STORE_FILE();
  try {
    // 留一份 .bak 作为上一完好版本，崩溃写坏后可回退
    if (fs.existsSync(file)) {
      try { fs.copyFileSync(file, `${file}.bak`); } catch { /* 备份失败不阻断主写入 */ }
    }
    const res = writeFileDurable(file, JSON.stringify(store, null, 2));
    if (!res.ok) console.error('[scheduled] 持久化失败:', res.error);
  } catch (e) {
    console.error('[scheduled] 持久化异常:', e.message);
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

// ── P0-8a：错过的计划执行扫描（补跑 / 标记，绝不静默）──

// 分钟的 ISO 键（秒/毫秒归零）：last_fired 的持久化格式，重启后可比较、可回放
function minuteIso(d) {
  const x = new Date(d);
  x.setSeconds(0, 0);
  return x.toISOString();
}

// 区间内逐分钟回放收集命中的分钟。区间为 (from, to]——左开右闭：from 是「已触发至此」的
// 游标（last_fired），该分钟已触发过，不重复计入。上限由调用方通过 SCAN_WINDOW_MAX_MS 控制，
// 7 天 = 10080 次纯内存 cron 判定，启动成本可忽略；区间超过上限时调用方已提前截断。
function collectMatchesBetween(expr, from, to) {
  const hits = [];
  if (!cronValid(expr)) return hits;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // 左开：跳过 from 当分钟（已触发）
  const end = new Date(to).getTime();
  while (d.getTime() <= end) {
    if (cronMatches(expr, d)) hits.push(new Date(d));
    d.setMinutes(d.getMinutes() + 1);
  }
  return hits;
}

// 同一自然日（本地时区）：宽限窗口判定——今天日内到期的计划执行允许补跑一次
function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function fmtLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 标记错过：写 missed 三件套 + 人话 last_result，并推进 last_fired 游标（避免重启后重复标记同一次错过）
function markMissed(t, reason, latestMatch) {
  t.missed = true;
  t.last_status = 'missed';
  t.last_result = reason;
  t.missed_at = new Date().toISOString();
  t.last_fired = minuteIso(latestMatch);
  persist();
  notify();
}

// 启动扫描：对每个启用任务回放 [last_fired, now] 区间内到期的分钟。
// - 最近一次到期与今天同日 → 补跑一次（trigger='catchup'）；
// - 否则（昨天及更早到期）→ 标记 missed，不补跑；
// - 距 last_fired 超过 7 天 → 窗口截断，只标记不补跑（超长缺失）；
// - 区间内没有任何到期分钟 → 原样不动（无错过可言）。
async function scanMissedTasks(now = new Date()) {
  for (const t of store.tasks) {
    if (!t.enabled) continue;
    if (t.valid_until && now.getTime() > new Date(`${t.valid_until}T23:59:59`).getTime()) continue;
    if (!cronValid(t.schedule)) continue;
    const rawFrom = t.last_fired || t.last_run_at || t.created_at;
    if (!rawFrom) { t.last_fired = minuteIso(now); persist(); continue; }
    const fromMs = new Date(rawFrom).getTime();
    if (Number.isNaN(fromMs)) { t.last_fired = minuteIso(now); persist(); continue; }
    // 刚触发过（不足一个 tick 间隔）时不扫描：当前分钟由 tick 正常覆盖，避免双触发
    if (now.getTime() - fromMs < TICK_MS) continue;
    let from = fromMs;
    let capped = false;
    if (now.getTime() - from > SCAN_WINDOW_MAX_MS) {
      from = now.getTime() - SCAN_WINDOW_MAX_MS;
      capped = true;
    }
    if (from >= now.getTime()) continue; // 无区间可扫（时钟回拨或刚刚触发过）
    const hits = collectMatchesBetween(t.schedule, new Date(from), now);
    if (hits.length === 0) {
      // 窗口内无到期执行：超长缺失时推进游标，避免每次重启都回放整个 7 天窗口
      if (capped) { t.last_fired = minuteIso(now); persist(); }
      continue;
    }
    const latest = hits[hits.length - 1];
    if (capped) {
      const days = Math.max(1, Math.round((now.getTime() - fromMs) / (24 * 60 * 60 * 1000)));
      markMissed(t, `已超过 ${days} 天未运行，期内到期的执行未安排补跑（仅记录，不补跑）`, latest);
      console.warn(`[scheduled] 任务「${t.name}」超长缺失（>${days} 天）：已标记 missed，未补跑`);
      continue;
    }
    if (isSameLocalDay(latest, now)) {
      // 宽限窗口内：补跑一次（幂等游标先行落盘，补跑异步失败也不重复触发）
      t.last_fired = minuteIso(latest);
      persist();
      console.warn(`[scheduled] 任务「${t.name}」在应用未运行期间到期（${fmtLocal(latest)}），安排补跑一次`);
      try {
        await runTask(t.id, 'catchup');
      } catch (e) {
        console.error('[scheduled] 补跑失败:', e.message);
      }
      continue;
    }
    const n = hits.length;
    markMissed(t, `应用未运行，错过 ${n} 次计划执行（最近一次应为 ${fmtLocal(latest)}）`, latest);
    console.warn(`[scheduled] 任务「${t.name}」错过 ${n} 次计划执行：已标记 missed`);
  }
}

// ── 执行 ──
// 无人值守的「假成功」识别。
//
// 事故背景（2026-10-17）：定时任务因宿主漏注入 web 工具，模型回了一整段「无法完成…如实说明」，
// 而 runTask 只在**抛异常**时判 failed，于是这条任务在 UI 上显示「成功」——
// 用户看到的是「成功了，但内容是说做不到」。这是比失败更坏的信号。
//
// 判定刻意保守：只有在**全程没调用过任何工具**且输出明确自述做不到时才判负。
// 有工具调用说明真干了活，结尾一句「部分数据缺失」不该推翻整轮结论。
const FAIL_MARKERS = [
  /无法完成/, /未能完成/, /无法获取/, /不具备/, /工具.{0,12}不存在/, /全部失败/, /没有任何(工具|结果)/,
  /unable to (complete|access|fetch)/i, /not available/i, /cannot complete/i, /no tools? (available|found)/i,
];
function detectUnfinished(output, toolCalls = 0) {
  const text = String(output || '').trim();
  if (!text) return '执行器返回空结果（模型未产出任何内容）';
  if (toolCalls > 0) return '';
  const hit = FAIL_MARKERS.find((re) => re.test(text));
  return hit ? `模型未调用任何工具且自述无法完成（命中「${String(hit).replace(/^\/|\/$/g, '')}」）——请检查任务所需能力是否已配置` : '';
}

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
      run.output = String(r?.output || '').slice(0, 20000);
      run.tools = Number(r?.toolCalls) || 0;
      run.tokens = r?.usage || null;
      // 没抛异常 ≠ 成功：模型自述做不到时要如实标失败
      const unfinished = detectUnfinished(run.output, run.tools);
      if (unfinished) { run.status = 'failed'; run.error = unfinished; } else { run.status = 'success'; }
    } else {
      const out = await execCtx.chatOnce({
        messages: [
          { role: 'system', content: '你是定时任务执行器：直接完成任务提示词中的要求并输出精炼结果，不要反问、不要输出无关寒暄。' },
          { role: 'user', content: String(t.prompt || '') },
        ],
      }, model);
      run.output = String(out || '').slice(0, 20000);
      const unfinished = detectUnfinished(run.output, 0);
      if (unfinished) { run.status = 'failed'; run.error = unfinished; } else { run.status = 'success'; }
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
  // P0-8b：状态字段写回任务对象（ScheduledTasks.jsx 的卡片直读 last_status/last_run_at/
  // last_result；此前 scheduler 从不写入这三个字段，UI 上「上次状态」恒为空）。
  // last_result 截断到 LAST_RESULT_MAX——任务对象随每次持久化落盘，不塞完整输出。
  t.last_status = run.status;
  t.last_run_at = run.started_at;
  t.last_result = (run.status === 'success'
    ? String(run.output || '')
    : String(run.error || run.output || '')).slice(0, LAST_RESULT_MAX);
  t.missed = false; // 实际执行过（无论成败）即不再是「错过」态
  delete t.missed_at;
  // 归档到 ~/Documents/.MJCoder/tasks/<任务名>/<YYYY-MM-DD>.md
  // 无人值守任务在应用外没有任何可查阅的产出，这里落一份按天归档的完整记录。
  // 写盘失败只告警：归档是附加能力，不能反噬任务本身的成败判定。
  try {
    await scheduledOutput.appendRunRecord({
      baseDir: documentsDir(), taskName: t.name, schedule: t.schedule, run,
    });
  } catch (e) {
    console.warn('[scheduled] 输出归档失败（不影响任务结果）:', e.message);
  }
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
  const key = minuteIso(now);
  for (const t of store.tasks) {
    if (!t.enabled) continue;
    if (t.valid_until && now.getTime() > new Date(`${t.valid_until}T23:59:59`).getTime()) continue;
    if (!cronValid(t.schedule) || !cronMatches(t.schedule, now)) continue;
    // P0-8a：幂等游标从内存 Map 改为任务对象上的持久化字段（重启后不重复触发，
    // 也是启动补跑扫描的区间起点）
    if (t.last_fired === key) continue;
    t.last_fired = key;
    persist();
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
  // P0-8a：启动补跑扫描——应用未运行期间到期的计划执行，补跑一次或标记 missed（绝不静默）。
  // 异步执行不阻塞启动；扫描内部对每个任务 await runTask，任务间串行防止并发踩踏。
  scanMissedTasks().catch((e) => console.error('[scheduled] 启动补跑扫描异常:', e.message));
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

// 创建定时任务（IPC 与模型工具共用同一实现，避免两套校验规则漂移）。
function createTask({ name, prompt, schedule, enabled, valid_until: validUntilRaw } = {}) {
  const nm = String(name || '').trim();
  const pr = String(prompt || '');
  const sc = String(schedule || '').trim();
  if (!nm || !pr || !sc) return { ok: false, error: '任务名称、提示词与 Cron 表达式必填' };
  if (!cronValid(sc)) return { ok: false, error: 'Cron 表达式无效（5 字段：分 时 日 月 周）' };
  const t = {
    id: `t-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    name: nm, prompt: pr, schedule: sc,
    enabled: enabled !== false,
    valid_until: validUntilRaw ? String(validUntilRaw).slice(0, 10) : null,
    created_at: new Date().toISOString(),
  };
  store.tasks.unshift(t);
  persist();
  notify();
  return { ok: true, task: t };
}

function registerIpc() {
  ipcMain.handle('scheduled:list', async () => ({ ok: true, tasks: store.tasks, runs: store.runs }));
  ipcMain.handle('scheduled:save', async (_, p = {}) => {
    // X14：调度任务会被无人值守执行，名称/提示词/表达式都必须在边界校验。
    // 保持既有信封契约（调用方读 r.ok），故把校验异常转成 {ok:false}
    try {
      guard.assertStrings(p, { name: 120, prompt: 20000, schedule: 120 });
    } catch (e) {
      return { ok: false, error: e.message };
    }
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
    return createTask({ name, prompt, schedule, enabled: p.enabled, valid_until: validUntil });
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
  cronValid, cronMatches, runTask, persist,
  // P0-8a：补跑扫描与区间回放导出（测试可注入固定 now 做确定性断言）
  scanMissedTasks, collectMatchesBetween,
  // 2026-10-17:假成功识别（纯函数，单测直调）
  detectUnfinished,
  // 2026-10-17：模型侧 scheduled_create 工具的落地实现（与 IPC 共用同一校验）
  createTask,
};

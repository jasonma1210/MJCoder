#!/usr/bin/env node
// 「清单一键执行」+「事件触发」回归（2026-10-18 补的两项能力）
//
// 守两条红线：
//   重放：同一动作只能执行一次（幂等）；HEAD 变了必须判 stale（不把 8 小时前的动作盖到现在）；
//         依赖会话上下文的动作（MCP/PR）不许重放。
//   事件：同一事件 id 只触发一次（webhook 重投很常见）；任务在跑时合并而不是排队；
//         事件入口必须校验 token、只认 POST /event。
import { createScheduledReplay } from '../main/scheduledReplay.js';
import { readHead, createScheduledGuard } from '../main/scheduledGuard.js';
import { selectEventTargets } from '../main/scheduler.js';
import { createScheduledEventServer } from '../main/scheduledEventServer.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const REPO = process.cwd();
const HEAD = readHead(REPO);
check('取到仓库 HEAD（锚点自检：不是 git 仓库时本套件无意义）', HEAD.length >= 7, HEAD.slice(0, 8));

// ── ① 重放：幂等 / stale / manual / 正常执行 ──
{
  let calls = 0;
  const replay = createScheduledReplay({ getHandlers: () => ({ gitCommit: async () => { calls += 1; return { ok: true, stdout: 'done' }; } }) });

  const done = await replay({ action: { status: 'executed', tool: 'git_commit', id: 'a' } });
  check('已处理过的动作拒绝重放（幂等）', done.code === 'not_pending' && calls === 0);

  const manual = await replay({ action: { status: 'pending', tool: 'mcp__call', id: 'b' } });
  check('MCP 类动作标记需人工（不盲目重放，避免绕开原授权路径）', manual.code === 'manual' && calls === 0);

  const stale = await replay({ action: { status: 'pending', tool: 'git_commit', cwd: REPO, head: 'deadbeefdeadbeef', id: 'c' } });
  check('HEAD 已变化 → stale（不允许把旧动作盖到当前工作区）', stale.code === 'stale' && calls === 0, stale.error);

  const noCwd = await replay({ action: { status: 'pending', tool: 'git_commit', id: 'd' } });
  check('缺工作目录 → 拒绝', noCwd.code === 'no_cwd' && calls === 0);

  const okRes = await replay({ action: { status: 'pending', tool: 'git_commit', cwd: REPO, head: HEAD, args: { message: 'x' }, id: 'e' } });
  check('同 HEAD 下重放成功且真的调到了实现', okRes.ok === true && calls === 1, JSON.stringify(okRes));
}
{
  let seenArgs = null;
  const replay = createScheduledReplay({ getHandlers: () => ({ gitCommit: async (a) => { seenArgs = a; return { ok: true }; } }) });
  await replay({ action: { status: 'pending', tool: 'git_commit', cwd: REPO, head: HEAD, args: { message: 'msg' } } });
  check('重放时必须带 cwd 且**不弹审批**（用户点执行=本次批准）',
    seenArgs?.cwd === REPO && seenArgs?.requireApproval === false && seenArgs?.message === 'msg',
    JSON.stringify(seenArgs));
}
{
  const replay = createScheduledReplay({ getHandlers: () => ({ gitCommit: async () => ({ ok: false, error: 'nothing to commit' }) }) });
  const r = await replay({ action: { status: 'pending', tool: 'git_commit', cwd: REPO, head: HEAD } });
  check('实现报错时如实返回 failed（不静默当成功）', r.ok === false && r.code === 'failed');
}
{
  const replay = createScheduledReplay({ getHandlers: () => ({ gitCommit: async () => { throw new Error('boom'); } }) });
  const r = await replay({ action: { status: 'pending', tool: 'git_commit', cwd: REPO, head: HEAD } });
  check('实现抛错时不把异常抛给 IPC（转成 failed）', r.ok === false && r.code === 'failed' && /boom/.test(r.error));
}

// ── ② 闸门产出的清单项必须带幂等键 / cwd / HEAD（重放的前提）──
{
  const g = createScheduledGuard({ runId: 'r-1', cwd: REPO });
  const wrapped = g.wrap({ gitCommit: async () => ({ ok: true }) });
  await wrapped.gitCommit({ message: 'a' });
  await wrapped.gitCommit({ message: 'b' });
  const list = g.take();
  check('清单项带幂等键（runId#序号，两条不重复）',
    list[0].id === 'r-1#0' && list[1].id === 'r-1#1', JSON.stringify(list.map((x) => x.id)));
  check('清单项带 cwd 与 HEAD 快照（重放前要能判 stale）',
    list[0].cwd === REPO && list[0].head === HEAD);
  check('可重放的项带 args（否则重放只能猜参数）', list[0].args?.message === 'a');
}
{
  const g = createScheduledGuard({ runId: 'r-2', cwd: REPO });
  const wrapped = g.wrap({ mcpCallTool: async () => ({ ok: true }) });
  await wrapped.mcpCallTool({ tool: 'x', args: { token: 'SECRET' } });
  const item = g.take()[0];
  check('不可重放的项**不留 args**（MCP 参数里可能有凭证，落盘即泄漏）',
    item.replayable === false && item.args === undefined);
}

// ── ③ 事件：匹配 / 去重 / 合并 ──
{
  const tasks = [
    { id: 'a', enabled: true, trigger_type: 'event', event_source: 'github', event_name: 'pr_opened', event_seen: ['e1'] },
    { id: 'b', enabled: true, trigger_type: 'event', event_source: 'github', event_name: 'pr_opened' },
    { id: 'c', enabled: true, trigger_type: 'event', event_source: 'github', event_name: 'pr_closed' },
    { id: 'd', enabled: false, trigger_type: 'event', event_source: 'github', event_name: 'pr_opened' },
    { id: 'e', enabled: true, trigger_type: 'cron', schedule: '0 9 * * *' },
  ];
  const r1 = selectEventTargets(tasks, { source: 'github', event: 'pr_opened', id: 'e1' });
  check('同一事件 id 不重复触发（webhook 重投）',
    r1.targets.map((t) => t.id).join(',') === 'b' && r1.skipped.some((s) => s.id === 'a' && s.reason === 'duplicate'),
    JSON.stringify(r1));
  const r2 = selectEventTargets(tasks, { source: 'github', event: 'pr_opened', id: 'e2' }, (id) => id === 'b');
  check('任务正在跑 → 合并（busy），不排队（否则一个 PR 的三条事件做三遍）',
    !r2.targets.some((t) => t.id === 'b') && r2.skipped.some((s) => s.id === 'b' && s.reason === 'busy'),
    JSON.stringify(r2.skipped));
  const r3 = selectEventTargets(tasks, { source: 'github', event: 'nope', id: 'e3' });
  check('事件名不匹配 → 不触发', r3.targets.length === 0);
  check('停用的任务与 cron 任务不参与事件匹配',
    selectEventTargets(tasks, { source: 'github', event: 'pr_opened', id: 'e4' }).targets.every((t) => t.id !== 'd' && t.id !== 'e'));
}
{
  const tasks = [
    { id: 'x', enabled: true, trigger_type: 'event', event_source: 's', event_name: 'n', event_seen: Array.from({ length: 60 }, (_, i) => `old-${i}`) },
  ];
  const r = selectEventTargets(tasks, { source: 's', event: 'n', id: 'new-1' });
  check('去重环很旧的事件不阻塞新事件（不是"见过 60 条就永远不再触发"）', r.targets.length === 1);
}

// ── ④ 事件入口（真起一个本地 HTTP，验 token / 路由 / 体积）──
{
  const seen = [];
  const srv = createScheduledEventServer({
    ingest: async (body) => { seen.push(body); return { ok: true, started: 1 }; },
    env: { MJ_SCHEDULED_EVENT_PORT: '0', MJ_SCHEDULED_EVENT_TOKEN: 'tok' },
    log: () => {},
  });
  const started = srv.start();
  const port = started.port || srv.port;
  // env 给 0 时不启动（0 视为未配置），这里显式验证「默认不监听」
  check('未配置端口时默认不监听（不会莫名多一个端口）', started.ok === false && started.reason === 'disabled');
  void port; void seen;
}
{
  // 真起服务：拿系统分配端口（先占 0 再取实际端口不方便，这里选一个高位端口）
  const port = 47000 + Math.floor(Math.random() * 900);
  const calls = [];
  const srv = createScheduledEventServer({
    ingest: async (body) => { calls.push(body); return { ok: true, matched: 1, started: 1 }; },
    env: { MJ_SCHEDULED_EVENT_PORT: String(port), MJ_SCHEDULED_EVENT_TOKEN: 'tok' },
    log: () => {},
  });
  const st = srv.start();
  const post = (opts = {}) => fetch(`http://127.0.0.1:${port}/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.token === false ? {} : { 'x-mj-token': 'tok' }) },
    body: opts.body === undefined ? JSON.stringify({ source: 'github', event: 'pr_opened', id: 'e1' }) : opts.body,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const noTok = await post({ token: false });
    check('缺 token 被拒（401）', noTok.status === 401 && noTok.body.error === 'bad_token');
    const badJson = await post({ body: '{oops' });
    check('非法 JSON 被拒（400）', badJson.status === 400 && badJson.body.error === 'invalid_json');
    const ok1 = await post({});
    check('正常事件被接收（200）并转交 ingest', ok1.status === 200 && ok1.body.ok === true && calls.length === 1, JSON.stringify(ok1.body));
    const wrongPath = await fetch(`http://127.0.0.1:${port}/other`, { method: 'POST', headers: { 'x-mj-token': 'tok' } });
    check('只认 POST /event（其他路径 404）', wrongPath.status === 404);
    const getReq = await fetch(`http://127.0.0.1:${port}/event`, { headers: { 'x-mj-token': 'tok' } });
    check('GET 不被接受', getReq.status === 404);
  } finally {
    srv.stop();
  }
}

console.log(`\nscheduled-replay-event: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;

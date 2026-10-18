#!/usr/bin/env node
// P1-5：用户自定义生命周期 hooks 的行为门禁（纯 Node，注入假执行器，不 spawn 真进程）
//
// 必须成立的事：
//   ① 无配置 → wrap 原样返回（零开销，不给工具调用平白加一层）；
//   ② preToolUse 放行 → 工具照常执行、结果原样；拦截 → 工具**不被调用**且回结构化失败；
//   ③ 显式 JSON 裁决可覆盖退出码（allow/deny 两个方向）；
//   ④ fail-open：脚本不存在（127）/ 执行器抛错 / 超时 → 一律放行并留痕；
//   ⑤ postToolUse 纯观察：结果绝不被改写，post 失败也不影响结果；
//   ⑥ 匹配器：'*' / 字面名 / '|' 多选 / re: 前缀 / 通道名均可命中，未命中不触发。
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { createToolHookRunner, normalizeHooks, hookMatches, parseDecision } = require(path.join(DESKTOP, 'main/toolHooks.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 假执行器：按命令名返回预置结果；记录每次收到的 stdin 载荷
function makeExec(behavior) {
  const calls = [];
  const execHook = async ({ command, timeoutMs, input }) => {
    calls.push({ command, timeoutMs, input: JSON.parse(input) });
    const b = behavior[command];
    if (!b) return { failed: false, code: 0, stdout: '', stderr: '' };
    if (typeof b === 'function') return b({ command, timeoutMs, input });
    return b;
  };
  execHook.calls = calls;
  return execHook;
}

// 构造 runner（直接用内存态：filePath 指向不存在的文件 → 初始为空，再通过 save 注入）
function runnerWith(list, execHook, logs = []) {
  const tmp = path.join(os.tmpdir(), `mjc-hooks-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const r = createToolHookRunner({ filePath: tmp, execHook, log: (m) => logs.push(String(m)) });
  if (list) r.save(list); // 写入内存态（落盘到临时文件，测试结束清理）
  r.__tmp = tmp;
  return r;
}
const cleanups = [];
function cleanup(r) { try { fs.unlinkSync(r.__tmp); } catch { /* 不存在即可 */ } }

const HANDLERS = () => ({
  writeFile: async (args) => ({ ok: true, path: args.path, wrote: true }),
  readFile: async () => ({ ok: true, content: 'hello' }),
});

// ── ① 无配置 → 原样返回 ─────────
{
  const r = runnerWith(null, makeExec({}));
  cleanups.push(r);
  const h = HANDLERS();
  const wrapped = r.wrap(h);
  check('无 hooks 配置时 wrap 原样返回同一个对象（零开销）', wrapped === h);
}

// ── ② pre 放行 / 拦截 ─────────
{
  const exec = makeExec({ 'ok.sh': { failed: false, code: 0, stdout: '', stderr: '' } });
  const r = runnerWith([{ name: 'gate', event: 'preToolUse', match: 'write_file', command: 'ok.sh' }], exec);
  cleanups.push(r);
  let called = 0;
  const h = r.wrap({ writeFile: async (args) => { called += 1; return { ok: true, path: args.path }; } });
  const res = await h.writeFile({ path: '/w/a.js' });
  check('pre 放行：工具照常执行', called === 1 && res.ok === true && res.path === '/w/a.js');
  check('pre 载荷含展示名与通道名',
    exec.calls[0].input.tool === 'write_file' && exec.calls[0].input.channel === 'writeFile',
    JSON.stringify(exec.calls[0].input).slice(0, 90));
}
{
  const exec = makeExec({ 'deny.sh': { failed: false, code: 1, stdout: '', stderr: '禁止写入 .env 文件' } });
  const r = runnerWith([{ name: 'env-guard', event: 'preToolUse', match: 'write_file', command: 'deny.sh' }], exec);
  cleanups.push(r);
  let called = 0;
  const h = r.wrap({ writeFile: async () => { called += 1; return { ok: true }; } });
  const res = await h.writeFile({ path: '/w/.env' });
  check('pre 非零退出：工具**不被调用**', called === 0);
  check('pre 拦截返回结构化失败（可被熔断/回喂识别）',
    res.ok === false && res.blockedByHook === true && res.hook === 'env-guard' && /禁止写入/.test(res.error),
    JSON.stringify(res).slice(0, 120));
}

// ── ③ 显式 JSON 裁决覆盖退出码 ─────────
{
  const exec = makeExec({ 'j.sh': { failed: false, code: 0, stdout: '{"decision":"deny","reason":"策略禁用"}\n', stderr: '' } });
  const r = runnerWith([{ name: 'json-deny', event: 'preToolUse', match: '*', command: 'j.sh' }], exec);
  cleanups.push(r);
  let called = 0;
  const res = await r.wrap({ readFile: async () => { called += 1; } }).readFile({});
  check('JSON deny 覆盖退出码 0（exit0 也能拦）', called === 0 && res.blockedByHook === true && /策略禁用/.test(res.error));

  const exec2 = makeExec({ 'j2.sh': { failed: false, code: 3, stdout: '{"decision":"allow"}', stderr: 'noise' } });
  const r2 = runnerWith([{ name: 'json-allow', event: 'preToolUse', match: '*', command: 'j2.sh' }], exec2);
  cleanups.push(r2);
  let called2 = 0;
  const res2 = await r2.wrap({ readFile: async () => { called2 += 1; return { ok: true }; } }).readFile({});
  check('JSON allow 覆盖非零退出码（exit3 也能放行）', called2 === 1 && res2.ok === true);
}

// ── ④ fail-open：127 / 抛错 / 超时 ─────────
{
  const exec = makeExec({
    'missing.sh': { failed: false, code: 127, stdout: '', stderr: 'command not found' },
    'boom.sh': () => { throw new Error('spawn EACCES'); },
    'slow.sh': { failed: true, timedOut: true, code: null, stdout: '', stderr: '' },
  });
  const logs = [];
  const r = runnerWith([
    { name: 'missing', event: 'preToolUse', match: '*', command: 'missing.sh' },
  ], exec, logs);
  cleanups.push(r);
  let called = 0;
  const res = await r.wrap({ readFile: async () => { called += 1; return { ok: true, content: 'x' }; } }).readFile({});
  check('脚本不存在（127）：fail-open 放行', called === 1 && res.ok === true);
  check('脚本不存在：留痕（用户能发现自己 hook 没生效）', logs.some((l) => /不可执行/.test(l)), logs.join(' | ').slice(0, 80));

  const logs2 = [];
  const r2 = runnerWith([{ name: 'boom', event: 'preToolUse', match: '*', command: 'boom.sh' }], exec, logs2);
  cleanups.push(r2);
  const res2 = await r2.wrap({ readFile: async () => ({ ok: true }) }).readFile({});
  check('执行器抛错：fail-open 放行 + 留痕',
    res2.ok === true && logs2.some((l) => /未运行/.test(l)));

  const logs3 = [];
  const r3 = runnerWith([{ name: 'slow', event: 'preToolUse', match: '*', command: 'slow.sh' }], exec, logs3);
  cleanups.push(r3);
  const res3 = await r3.wrap({ readFile: async () => ({ ok: true }) }).readFile({});
  check('超时：fail-open 放行 + 留痕（超时不是判否）',
    res3.ok === true && logs3.some((l) => /超时/.test(l)));
}

// ── ⑤ post 纯观察，不改结果 ─────────
{
  const exec = makeExec({
    'post.sh': { failed: false, code: 0, stdout: '', stderr: '' },
    'postbad.sh': { failed: false, code: 2, stdout: '', stderr: 'nope' },
  });
  const r = runnerWith([
    { name: 'audit', event: 'postToolUse', match: '*', command: 'post.sh' },
    { name: 'bad', event: 'postToolUse', match: '*', command: 'postbad.sh' },
  ], exec);
  cleanups.push(r);
  const original = { ok: true, content: 'RAW' };
  const res = await r.wrap({ readFile: async () => original }).readFile({ path: '/r/a.js' });
  check('post 钩子绝不改写工具结果', res === original, JSON.stringify(res));
  check('post 载荷带 result（供审计/统计）',
    exec.calls.some((c) => c.input.event === 'postToolUse' && c.input.result && c.input.result.content === 'RAW'));
  check('post 非零退出不影响工具结果（不抛不拦）', res.ok === true);
}

// ── ⑥ 匹配器 ─────────
{
  check("match '*' 命中任意", hookMatches('*', 'write_file', 'writeFile') === true);
  check("字面展示名命中", hookMatches('write_file', 'write_file', 'writeFile') === true);
  check("字面通道名命中", hookMatches('writeFile', 'write_file', 'writeFile') === true);
  check("'|' 多选：命中其中之一", hookMatches('write_file|apply_patch', 'apply_patch', 'applyPatch') === true);
  check("'|' 多选：未命中", hookMatches('write_file|apply_patch', 'read_file', 'readFile') === false);
  check('re: 前缀正则命中', hookMatches('re:^write_', 'write_file', 'writeFile') === true);
  check('re: 正则未命中', hookMatches('re:^write_', 'read_file', 'readFile') === false);
  check('非法正则不抛（视为不命中）', hookMatches('re:[', 'read_file', 'readFile') === false);
  check('未命中的 hook 不触发（组内过滤生效）', hookMatches('shell', 'read_file', 'readFile') === false);
}

// ── ⑦ 配置归一化 / 落盘 / 损坏 fail-open ─────────
{
  const n = normalizeHooks([
    { name: 'a', event: 'preToolUse', command: 'x.sh' },
    { name: 'b', event: 'bogus', command: 'y.sh' },        // 非法 event → 丢弃
    { name: 'c', event: 'postToolUse', command: '' },      // 无命令 → 丢弃
    { name: 'd', event: 'preToolUse', command: 'z.sh', timeoutMs: 999999, enabled: false },
  ]);
  check('归一化：非法 event / 空命令被丢弃', n.length === 2, `n=${n.length}`);
  check('归一化：缺省 match=* 且默认超时 5000', n[0].match === '*' && n[0].timeoutMs === 5000);
  check('归一化：超时封顶 60000、enabled 保留', n[1].timeoutMs === 60000 && n[1].enabled === false);
}
{
  const tmp = path.join(os.tmpdir(), `mjc-hooks-corrupt-${Date.now()}.json`);
  fs.writeFileSync(tmp, '{ not json');
  const r = createToolHookRunner({ filePath: tmp, execHook: makeExec({}), log: () => {} });
  check('配置损坏：按无 hooks 继续（fail-open，不抛）', r.list().length === 0);
  cleanups.push({ __tmp: tmp });
}
{
  const r = runnerWith([{ name: 'saved', event: 'preToolUse', match: '*', command: 'ok.sh' }], makeExec({}));
  cleanups.push(r);
  check('save 后可用', r.list().length === 1 && r.list()[0].name === 'saved');
  check('save 落盘为 0600', (fs.statSync(r.__tmp).mode & 0o777) === 0o600,
    (fs.statSync(r.__tmp).mode & 0o777).toString(8));
  check('reload 从磁盘回到同一份', r.reload().length === 1);
}

// ── ⑧ parseDecision 容错 ─────────
{
  check('parseDecision：非 JSON 返回 null', parseDecision('hello\n') === null);
  check('parseDecision：取第一行合法 JSON',
    parseDecision('note\n{"decision":"DENY","reason":"r"}\n').decision === 'deny');
  check('parseDecision：decision 非字符串返回 null', parseDecision('{"x":1}') === null);
}

for (const c of cleanups) cleanup(c);

console.log(`\ntool-hooks: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;

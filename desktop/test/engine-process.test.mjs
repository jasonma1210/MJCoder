// T3-7 门禁：引擎子进程驻留（main/engineProcess/）——用 child_process.fork 真实子进程跑全 RPC 协议。
// 覆盖：完整 run（chat→shell→done）/ abort 优雅收尾 / kill 后 engineExited 拒绝 /
//      onSuspend cbReq 往返 / 多会话并行互不影响 / 接线静态断言 / utilityProcess 缺失时降级判定。
// 说明：测试宿主是纯 Node（无 utilityProcess），经 initEngineHost({spawnChild}) 注入 fork——
// transport.js 的双形态适配让同一 childEntry 在两种宿主下协议语义一致，这正是被测点。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { fork } from 'node:child_process';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHILD_ENTRY = path.join(DESKTOP, 'main', 'engineProcess', 'childEntry.js');
const host = require(path.join(DESKTOP, 'main', 'engineProcess', 'host.js'));
const registry = require(path.join(DESKTOP, 'main', 'engineProcess', 'registry.js'));

let pass = 0, total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.stack || e.message}`); process.exitCode = 1; }
}

const BASE_MODEL = { provider: { id: 'p', base_url: 'http://x' }, model: { model_id: 'm' } };
const baseParams = (extra = {}) => ({
  messages: [{ role: 'user', content: 'go' }],
  model: BASE_MODEL,
  tokenBudget: 0,
  ...extra,
});
const spawnFork = () => fork(CHILD_ENTRY, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });

// ── 0. 未注入 spawnChild 且无 utilityProcess（纯 Node 宿主）→ 不可用（agentRunner 走 in-process 降级）──
check('纯 Node 宿主下 isAvailable()=false（降级链前提）', () => {
  assert.equal(host.isAvailable(), false);
});

host.initEngineHost({ spawnChild: spawnFork });

// ── 1. 完整 run：chat 驱动 shell 工具，事件流与 finalText 语义与 in-process 对齐 ──
await check('完整 run：toolReq 往返 + onToolCall/onDone 事件 + finalText', async () => {
  const events = [];
  let chatCalls = 0;
  const toolHandlers = {
    chat: async () => {
      chatCalls += 1;
      if (chatCalls === 1) {
        return {
          content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{"command":"echo hi"}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      }
      return { content: '完成', usage: { prompt_tokens: 5, completion_tokens: 2 } };
    },
    shell: async (args) => {
      assert.equal(args.command, 'echo hi');
      return { ok: true, stdout: 'hi\n' };
    },
  };
  const finalText = await host.runEngine('run-full', baseParams(), {
    toolHandlers,
    onEvent: (cb, args) => events.push({ cb, args }),
  });
  assert.equal(finalText, '完成');
  assert.equal(chatCalls, 2, `chat 应被 RPC 调用 2 次，实际 ${chatCalls}`);
  const tc = events.find((e) => e.cb === 'onToolCall');
  assert.ok(tc, '缺 onToolCall 事件');
  assert.match(JSON.stringify(tc.args), /hi/, 'tool_call 事件应携带工具结果');
  const done = events.find((e) => e.cb === 'onDone');
  assert.ok(done && done.args[0] === '完成' && done.args[2] === false, 'onDone 多参序列化错误');
});

// ── 2. abort：第一轮返回 tool_calls 后转发 abort，第二轮轮首信号检查优雅收尾 ──
await check('abort：子进程优雅收尾，onDone(aborted=true) 且 runEngine 正常 resolve', async () => {
  const events = [];
  let chatCalls = 0;
  const toolHandlers = {
    chat: async () => {
      chatCalls += 1;
      if (chatCalls === 1) {
        host.abortEngine('run-abort');
        return {
          content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      }
      return { content: '不应到达' };
    },
    shell: async () => ({ ok: true, stdout: '' }),
  };
  const finalText = await host.runEngine('run-abort', baseParams(), {
    toolHandlers,
    onEvent: (cb, args) => events.push({ cb, args }),
  });
  assert.equal(typeof finalText, 'string');
  assert.equal(chatCalls, 1, 'abort 后不应再发起第二轮 chat');
  const done = events.find((e) => e.cb === 'onDone');
  assert.ok(done && done.args[2] === true, 'onDone 应带 aborted=true');
});

// ── 3. kill：chat 挂起中杀进程 → engineExited 拒绝（验收①主进程存活的编程等价面）──
await check('kill 引擎进程：reject 带 engineExited 标记', async () => {
  let childRef = null;
  host.initEngineHost({ spawnChild: () => { childRef = spawnFork(); return childRef; } });
  const toolHandlers = { chat: () => new Promise(() => {}) }; // 永不返回，run 保持在途
  const p = host.runEngine('run-kill', baseParams(), { toolHandlers, onEvent: () => {} });
  await new Promise((r) => setTimeout(r, 500)); // 等 ready→run→toolReq 挂起
  assert.ok(childRef && childRef.exitCode === null, '子进程应仍在运行');
  childRef.kill('SIGKILL'); // 模拟引擎崩溃/被系统杀
  const err = await p.then(() => null, (e) => e);
  assert.ok(err, 'kill 后必须拒绝');
  assert.equal(err.engineExited, true, `应带 engineExited，实际：${err && err.message}`);
  host.initEngineHost({ spawnChild: spawnFork });
});

// ── 4. onSuspend cbReq 往返：tokenBudget 触闸 3 次救援后熔断，主进程收到断点信息 ──
await check('onSuspend：cbReq 送达主进程且收尾文案含断点提示', async () => {
  let chatCalls = 0;
  let suspendSeen = null;
  const toolHandlers = {
    // 每轮固定烧 1000 tokens：预算 100 下 3 次救援后第 4 轮触闸熔断
    chat: async () => {
      chatCalls += 1;
      return { content: 'x', usage: { prompt_tokens: 1000, completion_tokens: 0 } };
    },
  };
  const finalText = await host.runEngine('run-suspend', baseParams({ tokenBudget: 100 }), {
    toolHandlers,
    onEvent: () => {},
    onSuspend: (info) => { suspendSeen = info; return true; },
  });
  assert.ok(suspendSeen, '主进程 onSuspend 未收到 cbReq');
  assert.equal(suspendSeen.kind, 'tokens');
  assert.equal(chatCalls, 4, `应 3 救援+1 收尾共 4 轮，实际 ${chatCalls}`);
  assert.match(finalText, /断点已保存/, '收尾文案应含断点提示');
});

// ── 5. 多会话并行：两个 runId 各自独立子进程，互不影响（验收④）──
await check('多会话并行：两个引擎子进程互不干扰', async () => {
  const mk = (tag) => ({
    chat: async () => ({ content: `done-${tag}`, usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  });
  const [a, b] = await Promise.all([
    host.runEngine('run-x', baseParams(), { toolHandlers: mk('x'), onEvent: () => {} }),
    host.runEngine('run-y', baseParams(), { toolHandlers: mk('y'), onEvent: () => {} }),
  ]);
  assert.equal(a, 'done-x');
  assert.equal(b, 'done-y');
  assert.equal(host.listActiveRunIds().length, 0, '收尾后不应有在役进程');
});

// ── 6. registry 与 childEntry/host 协议一致性 + 主进程接线静态断言 ──
await check('协议登记表完整（26 工具通道 / onSuspend 请求-响应）', () => {
  assert.equal(registry.TOOL_CHANNELS.length, 26);
  assert.ok(registry.TOOL_CHANNELS.includes('chat') && registry.TOOL_CHANNELS.includes('shell'));
  assert.deepEqual(registry.REQUEST_CBS, ['onSuspend']);
});

await check('主进程接线：main.js 注入 engineHost / agentRunner 双路径与 engineExited 断点', () => {
  const mainSrc = fs.readFileSync(path.join(DESKTOP, 'main', 'main.js'), 'utf8');
  assert.match(mainSrc, /require\('\.\/engineProcess\/host'\)/);
  assert.match(mainSrc, /initAgentRunner\(\{[\s\S]{0,300}engineHost,/);
  const runnerSrc = fs.readFileSync(path.join(DESKTOP, 'main', 'agentRunner.js'), 'utf8');
  assert.match(runnerSrc, /deps\.engineHost[\s\S]{0,200}runEngine\(/);
  assert.match(runnerSrc, /err\.engineExited[\s\S]{0,400}saveCheckpoint/);
  assert.match(runnerSrc, /engineHost\?\.abortEngine\?\.\(/);
});

console.log(`\nengine-process: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);

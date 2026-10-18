// P0-1 / P0-2 回归门禁：记忆写入闭环 + 压缩摘要归档。
//
// 事故形态（第四轮审查结论）：记忆体系此前只有「读」闭环——引擎只 recall 注入，
//   全仓无任何自动写入路径；压缩摘要只写回对话（system 消息），不落记忆库，
//   跨会话即丢。本门禁锁两件事：
//   ① P0-2：compactHistory 成功压缩时必须透出 onCompacted（纯摘要、无前缀），
//           且钩子异常绝不影响压缩结果；
//   ② P0-1/P0-2：宿主（agentRunner）把「收尾结论」与「压缩摘要」归档进记忆库，
//           且严格守收纳判据（中止/无工具/闲聊/BLOCK/子代理 一律不写）。
import { createRequire } from 'node:module';
import path from 'node:path';
import { compactHistory } from '../agent-core/index.js';

const require = createRequire(import.meta.url);
const {
  initAgentRunner, startAgentRun, agentRunnerReady,
} = require(path.resolve(import.meta.dirname, '../main/agentRunner.js'));

let pass = 0;
let total = 0;
async function check(name, fn) {
  total++;
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    pass++;
  } catch (e) {
    console.log(`[FAIL] ${name}\n       ${e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 共用：构造必然触发压缩的长历史（与 compact-tail-budget.test.mjs 同构）──
const CTX = 128000;
const model = { provider: { id: 'probe' }, model: { model_id: 'probe-model', context_window: CTX } };
const fill = (n) => '压'.repeat(n);
function makeRound(i, toolsPerRound, perTool = 800) {
  const calls = Array.from({ length: toolsPerRound }, (_, k) => ({
    id: `call-${i}-${k}`,
    type: 'function',
    function: { name: 'read_file', arguments: JSON.stringify({ path: `src/f${i}-${k}.js` }) },
  }));
  const assistant = { role: 'assistant', content: `第 ${i} 轮：读取 ${toolsPerRound} 个文件`, tool_calls: calls };
  const tools = calls.map((c) => ({ role: 'tool', tool_call_id: c.id, content: fill(perTool) }));
  return [assistant, ...tools];
}
function buildBig() {
  const convo = [
    { role: 'system', content: `你是 MJCode 引擎。${fill(9000)}` },
    { role: 'user', content: '把这些文件里的问题都修掉，然后跑测试。' },
  ];
  // 30 轮 × 3 工具 × 3000 字符：确保体积越过 128k 窗口的 70% 触发线
  for (let i = 0; i < 30; i += 1) convo.push(...makeRound(i, 3, 3000));
  return convo;
}
const SUMMARY_TEXT = '【已完成】读取文件。【关键发现】src/f0.js。【待办】继续修复。【约束】不要改接口。';
const shortSummaryChat = async () => ({ content: SUMMARY_TEXT });

// ── 宿主侧：驱动一次 agentRunner 运行 ──
function makeSender() {
  const s = { events: [], destroyed: false, send: null, isDestroyed: () => s.destroyed };
  s.send = (ch, data) => { if (ch === 'agent:event') s.events.push(data); };
  return s;
}
const vp = (runId, extra = {}) => ({
  messages: [{ role: 'user', content: '帮我把登录模块重构一下' }],
  model: { provider: { id: 1 }, model: { model_id: 'test-model' } },
  ...extra,
  runId,
});

(async () => {
  // ═══ A. 引擎侧：compactHistory → onCompacted（P0-2）═══
  await check('A1 成功压缩时透出 onCompacted，且为空前缀的纯摘要', async () => {
    const seen = [];
    const out = await compactHistory(buildBig(), model, shortSummaryChat, {
      onCompacted: (info) => seen.push(info),
    });
    assert(out !== null && seen.length === 1, `onCompacted 应恰好调用一次，got=${seen.length}`);
    assert(String(seen[0].summary).includes('已完成'), `摘要内容应被透出，got=${seen[0].summary}`);
    assert(!String(seen[0].summary).includes('[早期对话摘要]'), '透出的应是纯摘要，不得带模型侧前缀');
    assert(seen[0].rounds > 0, 'rounds 应为被压缩的消息条数');
  });

  await check('A2 未达阈值（不压缩）时不调用 onCompacted', async () => {
    const seen = [];
    const small = [
      { role: 'system', content: '你是 MJCode 引擎。' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮你？' },
    ];
    const before = JSON.stringify(small);
    const out = await compactHistory(small, model, shortSummaryChat, { onCompacted: (i) => seen.push(i) });
    assert(JSON.stringify(out) === before, '小历史应原样返回');
    assert(seen.length === 0, `未压缩不应归档，got=${seen.length}`);
  });

  await check('A3 onCompacted 抛错不影响压缩结果（fail-open）', async () => {
    const out = await compactHistory(buildBig(), model, shortSummaryChat, {
      onCompacted: () => { throw new Error('归档钩子炸了'); },
    });
    assert(out && out.length > 0, '钩子异常时压缩结果仍必须正常返回');
    assert(out.some((m) => m.role === 'system' && String(m.content).includes('已完成')), '压缩仍应生效');
  });

  // ═══ B. 宿主侧：agentRunner 归档（P0-1 / P0-2）═══
  await agentRunnerReady();

  // B1：memory_saved trace → 归档压缩摘要
  await check('B1 memory_saved 事件落库（compressor / session / compression_summary）', async () => {
    const calls = [];
    const sender = makeSender();
    // 引擎会走 onTrace 通道发 memory_saved（此处直接模拟引擎的收发）
    initAgentRunner({
      loadAgentCore: async () => ({
        runAgent: async (opts) => {
          opts.onTrace?.({ type: 'memory_saved', origin: 'auto_compact', source: 'compressor', summary: SUMMARY_TEXT, rounds: 12 });
          opts.onDone?.('总结', null, false);
          return '总结';
        },
      }),
      createToolHandlers: () => ({}),
      rememberMemory: (args) => { calls.push(args); return { id: 'm1' }; },
    });
    startAgentRun(vp('b1', { projectPath: '/tmp/proj' }), sender);
    await sleep(60);
    const m = calls.find((c) => c.source === 'compressor');
    assert(m, `应归档压缩摘要，got=${JSON.stringify(calls)}`);
    assert(m.spaceId === '/tmp/proj', `空间键应为项目路径，got=${m.spaceId}`);
    assert(m.domain === 'session', `域应为 session，got=${m.domain}`);
    assert(Array.isArray(m.entityTags) && m.entityTags.includes('compression_summary'), '应带 compression_summary 标签');
  });

  // B2：正常收尾（有工具 + 未中止）→ 归档任务结论
  await check('B2 收尾归档任务结论（model_conclusion / run_conclusion）', async () => {
    const calls = [];
    initAgentRunner({
      loadAgentCore: async () => ({
        runAgent: async (opts) => {
          opts.onToolCall?.({ name: 'write_file', args: { path: 'a.js' }, result: { ok: true } });
          opts.onDone?.('已完成重构，改了 a.js 并跑通测试。', { prompt_tokens: 1, completion_tokens: 1 }, false);
          return '已完成重构，改了 a.js 并跑通测试。';
        },
      }),
      createToolHandlers: () => ({}),
      rememberMemory: (args) => { calls.push(args); return { id: 'm2' }; },
    });
    const sender = makeSender();
    startAgentRun(vp('b2', { projectPath: '/tmp/proj' }), sender);
    await sleep(60);
    const m = calls.find((c) => c.source === 'model_conclusion');
    assert(m, `有工具调用的收尾应归档结论，got=${JSON.stringify(calls)}`);
    assert(m.domain === 'session', `域应为 session，got=${m.domain}`);
    assert(String(m.content).includes('【任务】') && String(m.content).includes('【结论】'), '内容应含任务与结论两段');
    assert(String(m.content).includes('登录模块'), '任务描述应取自本轮用户消息');
  });

  // B3：无工具调用的纯闲聊 → 不归档
  await check('B3 无工具执行的闲聊不写记忆', async () => {
    const calls = [];
    initAgentRunner({
      loadAgentCore: async () => ({
        runAgent: async (opts) => { opts.onDone?.('你好', null, false); return '你好'; },
      }),
      createToolHandlers: () => ({}),
      rememberMemory: (args) => { calls.push(args); return { id: 'm3' }; },
    });
    startAgentRun(vp('b3', { projectPath: '/tmp/proj' }), makeSender());
    await sleep(60);
    assert(calls.length === 0, `闲聊不应写记忆，got=${JSON.stringify(calls)}`);
  });

  // B4：中止的运行 → 不归档
  await check('B4 中止的运行不写记忆', async () => {
    const calls = [];
    initAgentRunner({
      loadAgentCore: async () => ({
        runAgent: async (opts) => {
          opts.onToolCall?.({ name: 'shell', args: {}, result: { ok: true } });
          opts.onDone?.('半截结论', null, true); // aborted = true
          return '半截结论';
        },
      }),
      createToolHandlers: () => ({}),
      rememberMemory: (args) => { calls.push(args); return { id: 'm4' }; },
    });
    startAgentRun(vp('b4', { projectPath: '/tmp/proj' }), makeSender());
    await sleep(60);
    assert(calls.length === 0, `中止的运行不应写记忆，got=${JSON.stringify(calls)}`);
  });

  // B5：子代理（sub:true）的 memory_saved → 不归档
  await check('B5 子代理压缩摘要（sub:true）不归档', async () => {
    const calls = [];
    initAgentRunner({
      loadAgentCore: async () => ({
        runAgent: async (opts) => {
          opts.onTrace?.({ type: 'memory_saved', sub: true, source: 'compressor', summary: SUMMARY_TEXT });
          opts.onDone?.('done', null, false);
          return 'done';
        },
      }),
      createToolHandlers: () => ({}),
      rememberMemory: (args) => { calls.push(args); return { id: 'm5' }; },
    });
    startAgentRun(vp('b5', { projectPath: '/tmp/proj' }), makeSender());
    await sleep(60);
    assert(calls.length === 0, `子代理摘要不应归档，got=${JSON.stringify(calls)}`);
  });

  // B6：无 projectPath 时回落 cwd 作空间键
  await check('B6 缺 projectPath 时回落 cwd 作空间键', async () => {
    const calls = [];
    initAgentRunner({
      loadAgentCore: async () => ({
        runAgent: async (opts) => {
          opts.onToolCall?.({ name: 'shell', args: {}, result: { ok: true } });
          opts.onDone?.('结论', null, false);
          return '结论';
        },
      }),
      createToolHandlers: () => ({}),
      rememberMemory: (args) => { calls.push(args); return { id: 'm6' }; },
    });
    startAgentRun(vp('b6', { cwd: '/tmp/fallback' }), makeSender());
    await sleep(60);
    const m = calls.find((c) => c.source === 'model_conclusion');
    assert(m && m.spaceId === '/tmp/fallback', `应回落到 cwd，got=${m && m.spaceId}`);
  });

  // B7：归档失败绝不影响运行结果（fail-open）
  await check('B7 归档抛错不影响 done 事件与运行结果', async () => {
    initAgentRunner({
      loadAgentCore: async () => ({
        runAgent: async (opts) => {
          opts.onToolCall?.({ name: 'shell', args: {}, result: { ok: true } });
          opts.onDone?.('结论', null, false);
          return '结论';
        },
      }),
      createToolHandlers: () => ({}),
      rememberMemory: () => { throw new Error('DB 挂了'); },
    });
    const sender = makeSender();
    startAgentRun(vp('b7', { projectPath: '/tmp/proj' }), sender);
    await sleep(60);
    assert(sender.events.some((e) => e.type === 'done'), '归档失败也必须照常发 done');
    assert(!sender.events.some((e) => e.type === 'error'), '归档失败不得升级为运行错误');
  });

  console.log(`\n${pass === total ? 'PASS' : 'FAIL'}：${pass}/${total} 项通过`);
  process.exit(pass === total ? 0 : 1);
})();

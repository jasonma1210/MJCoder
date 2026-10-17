// P1-11a + P0-3② 任务-模型分档门禁（2026-10-18 全量修复）
//
// 动机：压缩摘要与任务拆分是「写摘要 / 出 JSON」这类低难度调用，用主模型（贵、慢）跑纯浪费；
//   但两者都是**恢复路径**，配置错误绝不能让它们挂掉——必须静默回落主模型。
// 关键设计（勿"按施工单修回去"）：override 模型**只**用于执行摘要，
//   **不参与窗口口径**（keepTailTokens / 激进档判定取主对话模型的窗口）——
//   8k 窗口的便宜摘要器若把窗口换小，尾部只留 2k，模型会丢掉刚读过的文件内容。
//
// 本套件锁三件事：
//   ① 合法 override：摘要请求走 cheap 模型 + cheap baseUrl，主请求仍走主模型；
//   ② 非法 override（缺 model 名）：回落主模型、不抛错、有 warn；
//   ③ decomposeTask 透传 override 模型，且继承主模型的 reasoning_effort。
import {
  runAgent, decomposeTask, resolveTaskModel,
} from '../agent-core/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const mainModel = {
  provider: { id: 1, isGlobal: false, base_url: 'https://api.main/v1' },
  model: { id: 1, model_id: 'main-model', context_window: 1000, reasoning_effort: 'high' },
};

function buildHistory() {
  const convo = [{ role: 'system', content: 'SYS' }, { role: 'user', content: '开始长任务' }];
  for (let i = 0; i < 10; i += 1) {
    convo.push({ role: 'assistant', content: `第 ${i} 步`, tool_calls: [{ id: `q${i}`, type: 'function', function: { name: 'shell', arguments: '{"command":"echo"}' } }] });
    convo.push({ role: 'tool', tool_call_id: `q${i}`, content: 'v'.repeat(300) });
  }
  return convo;
}

async function runWith(overrides) {
  const payloads = [];
  let rounds = 0;
  const toolHandlers = {
    chat: async (payload) => {
      const isMain = Array.isArray(payload.tools) && payload.tools.length > 0;
      payloads.push({ isMain, model: payload.model, baseUrl: payload.baseUrl, providerId: payload.providerId, reasoningEffort: payload.reasoningEffort });
      if (!isMain) return { content: '【已完成】a\n【关键发现】b\n【待办】c\n【约束】d', usage: { prompt_tokens: 30, completion_tokens: 10 } };
      rounds += 1;
      if (rounds > 6) return { content: '完成', usage: { prompt_tokens: 50, completion_tokens: 10 } };
      return {
        content: `第 ${rounds} 步`,
        tool_calls: [{ id: `m${rounds}`, type: 'function', function: { name: 'shell', arguments: '{"command":"echo"}' } }],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      };
    },
    shell: async () => ({ stdout: 'o'.repeat(600), stderr: '', exitCode: 0 }),
  };
  await runAgent({
    messages: buildHistory(),
    model: mainModel,
    modelOverrides: overrides,
    toolHandlers,
    tokenBudget: 0,
    maxRounds: 8,
    onMessage: () => {},
  });
  return payloads;
}

// ── ① 合法 override ──
{
  const payloads = await runWith({ compact: { providerId: 9, baseUrl: 'http://cheap', model: 'cheap-model' } });
  const summaries = payloads.filter((p) => !p.isMain);
  const mains = payloads.filter((p) => p.isMain);
  check('确实发生了压缩（存在摘要请求）', summaries.length > 0, `summaries=${summaries.length}`);
  check('摘要请求用 override 模型（model === cheap-model）', summaries[0]?.model === 'cheap-model', `got=${summaries[0]?.model}`);
  check('摘要请求用 override baseUrl（=== http://cheap）', summaries[0]?.baseUrl === 'http://cheap', `got=${summaries[0]?.baseUrl}`);
  check('摘要请求用 override providerId（=== 9）', summaries[0]?.providerId === 9, `got=${summaries[0]?.providerId}`);
  check('主请求仍是主模型（不被子模型顶替）', mains.every((p) => p.model === 'main-model'), `models=${[...new Set(mains.map((p) => p.model))].join(',')}`);
  check('主请求 reasoningEffort 仍透传主模型的 high', mains.every((p) => p.reasoningEffort === 'high'),
    `efforts=${[...new Set(mains.map((p) => p.reasoningEffort))].join(',')}`);
}

// ── ② 非法 override：静默回落，不抛错 ──
{
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warns.push(args.join(' ')); };
  let threw = null;
  let payloads = [];
  try {
    payloads = await runWith({ compact: { providerId: 9 } }); // 缺 model 名
  } catch (e) {
    threw = e;
  } finally {
    console.warn = origWarn;
  }
  check('非法 override 不抛错（恢复路径不允许被配置错误挂掉）', threw === null, String(threw?.message || ''));
  const summaries = payloads.filter((p) => !p.isMain);
  check('非法 override 回落主模型', summaries.length > 0 && summaries[0]?.model === 'main-model',
    `got=${summaries[0]?.model}`);
  check('回落时留下 warn（不静默吞掉配置错误）',
    warns.some((w) => w.includes('modelOverrides.compact') && w.includes('回落主模型')),
    warns.filter((w) => w.includes('modelOverrides')).join(' | ').slice(0, 160));
  check('resolveTaskModel 直接调用也回落主模型（纯函数契约）',
    resolveTaskModel(mainModel, { compact: { providerId: 9 } }, 'compact') === mainModel);
}

// ── ③ decomposeTask：override 模型 + 继承主模型思考强度 ──
{
  const payloads = [];
  const toolHandlers = {
    chat: async (payload) => {
      payloads.push({ model: payload.model, reasoningEffort: payload.reasoningEffort, baseUrl: payload.baseUrl });
      return { content: '{"decompose":false,"reason":"任务太小","tasks":[]}' };
    },
  };
  await decomposeTask({
    messages: [{ role: 'user', content: '把大任务拆一下' }],
    model: mainModel,
    modelOverrides: { decompose: { providerId: 9, baseUrl: 'http://decompose', model: 'decompose-model' } },
    toolHandlers,
  });
  check('decomposeTask 使用 override 模型（model === decompose-model）', payloads[0]?.model === 'decompose-model', `got=${payloads[0]?.model}`);
  check('decomposeTask 使用 override baseUrl', payloads[0]?.baseUrl === 'http://decompose', `got=${payloads[0]?.baseUrl}`);
  check('decomposeTask 继承主模型 reasoningEffort（high）', payloads[0]?.reasoningEffort === 'high', `got=${payloads[0]?.reasoningEffort}`);
  check('decomposeTask 只发一次请求（不重复调用）', payloads.length === 1, `calls=${payloads.length}`);
}

console.log(`\nmodel-override: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);

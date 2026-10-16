// T1-3 子代理事件透出测试（2026-10-15）
//
// 覆盖三层：
//   ① 引擎层：spawn_subagent 生命周期事件序列（spawn → progress* → done|failed），
//      tokens 累计 / 结论摘要 / 耗时 / budgetKind 如实上报（真实 runAgent + 脚本化 chat）
//   ② 契约层：引擎实际发出的事件逐条通过 T0-2 validateAgentEvent（防形状漂移）
//   ③ 编排层：waitGroupSettled 轮询快照逐帧回调 + diffGroupEvents 状态机映射
//      （queued→running→done / 失败重试回队 / skipped 失败传播）
import { runAgent } from '../agent-core/index.js';
import { validateAgentEvent } from '../shared-ipc/contract.mjs';
import { waitGroupSettled, diffGroupEvents } from '../main/orchestrator/invoke.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const model = {
  provider: { id: 1, isGlobal: false, base_url: 'https://api.example.com/v1' },
  model: { id: 1, model_id: 'test-chat', context_window: 128000 },
};

let chatScript = [];
function makeToolHandlers() {
  return {
    chat: async () => chatScript.shift() || { content: '（默认回复）', usage: { prompt_tokens: 5, completion_tokens: 3 } },
    readFile: async () => ({ content: 'file-content' }),
    listDir: async () => [],
    grep: async () => ({ matches: '' }),
    glob: async () => ({ files: [] }),
    gitStatus: async () => ({ stdout: '' }),
    gitDiff: async () => ({ stdout: '' }),
    gitLog: async () => ({ stdout: '' }),
    shell: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    writeFile: async () => ({ ok: true }),
    editFile: async () => ({ ok: true }),
    applyPatch: async () => ({ stdout: 'patched' }),
    mcpCallTool: async () => ({ content: [] }),
  };
}

// 父代理一轮：spawn_subagent(args) → 子代理跑完 → 父代理文本收尾；收集全部 subagent 事件
async function runParent(spawnArgs, subScript) {
  chatScript = [
    { content: '父代理派发', tool_calls: [{ id: 'p1', function: { name: 'spawn_subagent', arguments: JSON.stringify(spawnArgs) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } },
    ...subScript,
    { content: '父代理收尾', usage: { prompt_tokens: 100, completion_tokens: 20 } },
  ];
  const events = [];
  await runAgent({
    messages: [{ role: 'user', content: '派个子代理' }],
    model, cwd: '/tmp',
    // V02 运行时白名单守卫（2026-10-16）：引擎只放行「通告过」的工具——
    // 父代理要派发子代理，必须显式通告 spawn_subagent（原 tools:[] 依赖 switch 无守卫分发的旧语义已废除）
    tools: [{ type: 'function', function: { name: 'spawn_subagent', description: '派发只读子代理', parameters: { type: 'object', properties: {} } } }],
    maxRounds: 4,
    toolHandlers: makeToolHandlers(),
    onMessage: () => {},
    onSubagentEvent: (evt) => events.push(evt),
  });
  return events;
}

(async () => {
  // ── ① 正常收尾：spawn → progress×2 → done，tokens/summary/ms 齐全 ──
  {
    const events = await runParent({ objective: '找出入口文件', task_type: 'explore' }, [
      { content: '子代理看文件', tool_calls: [{ id: 's1', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }], usage: { prompt_tokens: 50, completion_tokens: 10 } },
      { content: '子代理结论：入口在 index.js', usage: { prompt_tokens: 60, completion_tokens: 15 } },
    ]);
    const phases = events.map((e) => e.phase);
    // 子代理最终回复（无 tool_calls）由引擎直接收尾，不进 onMessage——progress 数=中间轮数
    check('事件序列 spawn → progress → done',
      JSON.stringify(phases) === JSON.stringify(['spawn', 'progress', 'done']), phases.join(','));
    check('spawn 事件带 objective/taskType',
      events[0].tool === 'spawn_subagent' && events[0].objective === '找出入口文件' && events[0].taskType === 'explore');
    check('progress 事件 tokens 递增累计',
      events[1].tokens > 0, `tokens=${events[1].tokens}`);
    const done = events[events.length - 1];
    check('done 事件带结论摘要（子代理结论可见）', String(done.summary || '').includes('入口在 index.js'));
    check('done 事件带耗时与终态 tokens', typeof done.ms === 'number' && done.tokens > 0, `ms=${done.ms}, tokens=${done.tokens}`);
    check('全部事件通过 T0-2 契约校验', events.every((e) => validateAgentEvent({ runId: 'r', type: 'subagent', data: e }).ok));
  }

  // ── ② 预算耗尽：终态 failed，budgetKind=tokens，部分结论仍透出 ──
  {
    const sub = [];
    for (let i = 0; i < 8; i += 1) {
      sub.push({ content: `第 ${i} 轮`, tool_calls: [{ id: `s${i}`, function: { name: 'read_file', arguments: '{"path":"a.js"}' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
    }
    const events = await runParent({ objective: '大扫描', token_budget: 200 }, sub);
    const last = events[events.length - 1];
    check('预算耗尽终态为 failed', last.phase === 'failed', last.phase);
    check('failed 事件 budgetKind=tokens（失败模式可见）', last.budgetKind === 'tokens', last.budgetKind);
    check('failed 事件仍带部分结论摘要', typeof last.summary === 'string' && last.summary.length > 0);
    // 无结论（子代理未产出）时必须带 error 说明提前停止
  }

  // ── ②-b 无结论收尾：failed 事件带 error 说明 ──
  {
    const sub = [
      { content: '', tool_calls: [{ id: 's0', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } },
      { content: '   ', usage: { prompt_tokens: 100, completion_tokens: 10 } },
    ];
    const events = await runParent({ objective: '空结论目标', token_budget: 50 }, sub);
    const last = events[events.length - 1];
    check('无结论终态 failed 且 error 说明提前停止',
      last.phase === 'failed' && String(last.error || '').includes('提前停止'), `${last.phase}/${last.error || '-'}`);
  }

  // ── ③ 编排轮询：快照逐帧回调 + 终态 resolve ──
  {
    // fake store：三帧快照（running → running → done 终态）
    const frames = [
      { status: 'running', tasks: [{ taskId: 't1', title: 'A', status: 'running', retryCount: 0 }] },
      { status: 'running', tasks: [{ taskId: 't1', title: 'A', status: 'running', retryCount: 0 }] },
      { status: 'done', tasks: [{ taskId: 't1', title: 'A', status: 'done', retryCount: 0, result: { summary: '完成了', tokensUsed: 123 } }] },
    ];
    const store = { getGroup: () => frames.shift() };
    const polls = [];
    const r = await waitGroupSettled(store, 'g1', { pollIntervalMs: 10, onPoll: (g) => polls.push(g) });
    check('每帧快照都回调 onPoll（含首帧与终态帧）', polls.length === 3 && polls[0].status === 'running');
    check('终态 resolve 带 group', r.group?.status === 'done' && !r.aborted && !r.timedOut && !r.missing);
  }

  // ── ④ diffGroupEvents 状态机映射：并行推进 + 失败传播 + 重试回队 ──
  {
    const seen = new Map();
    const t = (taskId, title, status, extra = {}) => ({ taskId, title, status, retryCount: 0, ...extra });
    // 帧一：首次建档（spawn 已另行发出，不重复）
    const e1 = diffGroupEvents(seen, { tasks: [t('a', 'A', 'queued'), t('b', 'B', 'queued')] });
    check('首次建档不产生事件（spawn 另行发出）', e1.length === 0);
    // 帧二：A 开始跑，B 依赖 A 完成 → A running
    const e2 = diffGroupEvents(seen, { tasks: [t('a', 'A', 'running'), t('b', 'B', 'queued')] });
    check('queued→running 映射 progress', e2.length === 1 && e2[0].phase === 'progress' && e2[0].taskId === 'a');
    // 帧三：A done（带 tokens/summary）
    const e3 = diffGroupEvents(seen, { tasks: [t('a', 'A', 'done', { result: { summary: 'A 完成', tokensUsed: 88 } }), t('b', 'B', 'queued')] });
    check('done 事件带 tokens 与 summary', e3.length === 1 && e3[0].phase === 'done' && e3[0].tokens === 88 && e3[0].summary === 'A 完成');
    // 帧四：B running → failed（error 透出）→ 帧五：B 重试回队
    const e4 = diffGroupEvents(seen, { tasks: [t('a', 'A', 'done'), t('b', 'B', 'failed', { error: '命令超时', retryCount: 1 })] });
    check('failed 事件透出 error 与重试轮次', e4.length === 1 && e4[0].phase === 'failed' && e4[0].error === '命令超时' && e4[0].round === 1);
    const e5 = diffGroupEvents(seen, { tasks: [t('a', 'A', 'done'), t('b', 'B', 'queued', { retryCount: 1 })] });
    check('失败重试回队发 progress 提示', e5.length === 1 && e5[0].phase === 'progress' && String(e5[0].error || '').includes('重试'));
    // 帧六：B done → 帧七：出现 skipped（依赖失败传播）——B 已终态不再变；新增 c 被跳过
    diffGroupEvents(seen, { tasks: [t('a', 'A', 'done'), t('b', 'B', 'done', { result: { summary: 'B 补跑完成' } })] });
    const e7 = diffGroupEvents(seen, { tasks: [t('a', 'A', 'done'), t('b', 'B', 'done'), t('c', 'C', 'skipped')] });
    check('skipped 传播为 failed（依赖未达成）', e7.length === 1 && e7[0].phase === 'failed' && e7[0].taskId === 'c' && String(e7[0].error).includes('跳过'));
    // 无变化帧不重复发事件
    const e8 = diffGroupEvents(seen, { tasks: [t('a', 'A', 'done'), t('b', 'B', 'done'), t('c', 'C', 'skipped')] });
    check('无状态变化不产生事件（幂等去重）', e8.length === 0);
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})();

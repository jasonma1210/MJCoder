// P0-4 主进程 Agent 运行器测试：事件流 / 中止 / 未知 runId / sender 销毁防护 / done 兜底
// T0-2 追加：启动载荷契约拒绝（fail-closed）/ 非法事件降级为 error（不静默）
const { initAgentRunner, startAgentRun, abortRun, abortAllRuns, agentRunnerReady } = require('../main/agentRunner');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSender() {
  const s = { events: [], destroyed: false, send: null, isDestroyed: () => s.destroyed };
  s.send = (ch, data) => { if (ch === 'agent:event') s.events.push(data); };
  return s;
}

// 契约合法的最小启动载荷（与渲染层真实发送形状一致：messages + 嵌套形 model）
const vp = (runId, extra = {}) => ({
  messages: [{ role: 'user', content: 'hi' }],
  model: { provider: { id: 1 }, model: { model_id: 'test-model' } },
  ...extra,
  runId,
});

(async () => {
  // 契约异步加载（动态 import ESM）——先就绪再跑，保证校验行为确定性
  await agentRunnerReady();
  // ── 正常运行：消息/工具/事件流 + done（usage 透传）──
  initAgentRunner({
    loadAgentCore: async () => ({
      runAgent: async (opts) => {
        opts.onMessage?.({ role: 'assistant', content: '中间消息' });
        opts.onStream?.('');
        opts.onToolCall?.({ name: 'shell', args: {}, result: { ok: true } });
        opts.onDone?.('任务完成', { prompt_tokens: 10, completion_tokens: 5 }, false);
        return '任务完成';
      },
    }),
    createToolHandlers: () => ({}),
  });
  const sender = makeSender();
  const res = startAgentRun(vp('r1'), sender);
  check('startAgentRun 立即返回 runId', res.ok === true && res.runId === 'r1');
  await sleep(50);
  const types = sender.events.map((e) => e.type);
  check('事件流完整（message/stream/tool_call/done）',
    types.includes('message') && types.includes('stream') && types.includes('tool_call') && types.includes('done'),
    types.join(','));
  check('事件携带正确 runId', sender.events.every((e) => e.runId === 'r1'));
  const doneEvt = sender.events.find((e) => e.type === 'done');
  check('done 事件含 finalText/usage/aborted', doneEvt?.data?.finalText === '任务完成' && doneEvt?.data?.usage?.prompt_tokens === 10 && doneEvt?.data?.aborted === false);
  check('done 仅发送一次（onDone 与 return 兜底去重）', sender.events.filter((e) => e.type === 'done').length === 1);

  // ── 引擎不回调 onDone 时的 done 兜底 ──
  initAgentRunner({
    loadAgentCore: async () => ({ runAgent: async () => '直接返回' }),
    createToolHandlers: () => ({}),
  });
  const s2 = makeSender();
  startAgentRun(vp('r2'), s2);
  await sleep(30);
  check('引擎未回调 onDone 时兜底发送 done', s2.events.filter((e) => e.type === 'done').length === 1);

  // ── 引擎抛错 → error 事件 ──
  initAgentRunner({
    loadAgentCore: async () => ({ runAgent: async () => { throw new Error('引擎炸了'); } }),
    createToolHandlers: () => ({}),
  });
  const s3 = makeSender();
  startAgentRun(vp('r3'), s3);
  await sleep(30);
  check('引擎异常推送 error 事件且含原因', s3.events.some((e) => e.type === 'error' && e.data.includes('引擎炸了')));

  // ── 中止：abortRun 触发 signal ──
  let signalAborted = false;
  initAgentRunner({
    loadAgentCore: async () => ({ runAgent: (opts) => new Promise((resolve) => { opts.signal.addEventListener('abort', () => { signalAborted = true; resolve('已中止'); }); }) }),
    createToolHandlers: () => ({}),
  });
  const s4 = makeSender();
  startAgentRun(vp('r4'), s4);
  await sleep(10);
  check('abortRun 命中运行中任务', abortRun('r4') === true);
  await sleep(30);
  check('abort 后引擎 signal 置位且正常收尾', signalAborted === true && s4.events.some((e) => e.type === 'done'));
  check('abortRun 对未知 runId 返回 false', abortRun('r-unknown') === false);

  // ── abortAllRuns ──
  const s5 = makeSender();
  const s6 = makeSender();
  startAgentRun(vp('r5'), s5);
  startAgentRun(vp('r6'), s6);
  await sleep(10);
  check('abortAllRuns 中止全部挂起运行', abortAllRuns() === 2);
  await sleep(30);
  check('全部运行正常收尾', s5.events.some((e) => e.type === 'done') && s6.events.some((e) => e.type === 'done'));

  // ── sender 已销毁：事件推送不崩溃 ──
  const s7 = makeSender();
  startAgentRun(vp('r7'), s7);
  s7.destroyed = true;
  await sleep(30);
  check('sender 销毁后事件推送静默跳过（不崩溃）', s7.events.length === 0);

  // ── 2026-10-15：主进程侧消息持久化（总结不再依赖渲染层回调落库）──
  const persisted = [];
  initAgentRunner({
    loadAgentCore: async () => ({
      runAgent: async (opts) => {
        opts.onMessage?.({ role: 'assistant', content: '中间轮', tool_calls: [{ id: 't1' }], tokens_input: 5, tokens_output: 2 });
        opts.onMessage?.({ role: 'tool', tool_call_id: 't1', content: 'tool 结果' });
        opts.onDone?.('最终总结', { prompt_tokens: 10, completion_tokens: 5 }, false);
        return '最终总结';
      },
    }),
    createToolHandlers: () => ({}),
    persistMessage: ({ conversationId, message }) => { persisted.push({ conversationId, message }); return { ok: true }; },
  });
  const s8 = makeSender();
  startAgentRun(vp('r8', { conversationId: '42' }), s8);
  await sleep(30);
  const persistedRoles = persisted.map((p) => p.message.role);
  check('主进程落库：中间轮 assistant/tool/最终总结全部写入',
    JSON.stringify(persistedRoles) === JSON.stringify(['assistant', 'tool', 'assistant']),
    persistedRoles.join(','));
  check('主进程落库：threadId 取自 conversationId', persisted.every((p) => p.conversationId === '42'));
  const finalPersisted = persisted[persisted.length - 1]?.message || {};
  check('主进程落库：最终消息含 camelCase 用量与模型名',
    finalPersisted.tokensInput === 10 && finalPersisted.tokensOutput === 5 && finalPersisted.modelName === 'test-model');
  const doneEvt8 = s8.events.find((e) => e.type === 'done');
  check('done 事件携带 mainPersisted 标记（渲染层去重依据）', doneEvt8?.data?.mainPersisted === true);

  // ── 2026-10-15：持久化通道抛错不影响运行收尾 ──
  initAgentRunner({
    loadAgentCore: async () => ({
      runAgent: async (opts) => { opts.onDone?.('总结', { prompt_tokens: 1, completion_tokens: 1 }, false); return '总结'; },
    }),
    createToolHandlers: () => ({}),
    persistMessage: () => { throw new Error('线程不存在'); },
  });
  const s9 = makeSender();
  startAgentRun(vp('r9', { conversationId: '99' }), s9);
  await sleep(30);
  check('持久化失败仅告警，done 事件照常送达', s9.events.some((e) => e.type === 'done' && e.data.finalText === '总结'));

  // ── T0-2：启动载荷契约校验（fail-closed）──
  {
    const bad1 = startAgentRun({ runId: 'rbad1', messages: [] }, makeSender());
    check('空 messages 启动被契约拒绝', bad1.ok === false && /契约/.test(bad1.error), bad1.error);
    const bad2 = startAgentRun({ runId: 'rbad2', messages: [{ role: 'user', content: 'x' }], model: { providerId: 1, model: 'm' } }, makeSender());
    check('扁平形 model 启动被契约拒绝（历史 TypeError 根因）', bad2.ok === false && /model/.test(bad2.error), bad2.error);
    const bad3 = startAgentRun({ messages: [{ role: 'user', content: 'x' }], model: { provider: { id: 1 }, model: { model_id: 'm' } } }, makeSender());
    check('缺 runId 启动被契约拒绝', bad3.ok === false, bad3.error);
  }

  // ── T0-2：非法事件降级为 error（不静默丢弃）──
  {
    initAgentRunner({
      loadAgentCore: async () => ({
        runAgent: async (opts) => {
          opts.onToolCall?.({ name: 123 }); // 非法：name 必须是非空字符串
          opts.onDone?.('收尾', null, false);
          return '收尾';
        },
      }),
      createToolHandlers: () => ({}),
    });
    const s10 = makeSender();
    startAgentRun(vp('rdg'), s10);
    await sleep(30);
    const errEvt = s10.events.find((e) => e.type === 'error');
    check('非法 tool_call 事件被降级为 error 事件（可见而非静默）',
      !!errEvt && /契约校验失败/.test(String(errEvt.data)), String(errEvt?.data || '无 error 事件').slice(0, 80));
    check('降级不吞后续合法 done 事件', s10.events.some((e) => e.type === 'done' && e.data.finalText === '收尾'));
  }

  // ── T4-3：角色模板透传 + 审批档/沙箱「取更严格者」钳制 ──
  {
    const seenOpts = [];
    initAgentRunner({
      loadAgentCore: async () => ({
        runAgent: async (opts) => { seenOpts.push(opts); opts.onDone?.('r', null, false); return 'r'; },
      }),
      createToolHandlers: () => ({}),
    });
    const s11 = makeSender();
    const preset = { systemPrompt: '你是可视化工程师', toolNames: ['read_file', 'write_file'], approvalMode: 'on-request', sandboxPolicy: 'read-only' };
    startAgentRun(vp('rp1', { approvalMode: 'auto-safe', sandboxPolicy: 'workspace-write', rolePreset: preset }), s11);
    await sleep(30);
    check('rolePreset 原样透传进引擎参数', seenOpts[0]?.rolePreset?.systemPrompt === preset.systemPrompt
      && JSON.stringify(seenOpts[0]?.rolePreset?.toolNames) === JSON.stringify(preset.toolNames));
    check('审批档取更严格者（用户 auto-safe + 角色 on-request → on-request）',
      seenOpts[0]?.approvalMode === 'on-request', `got=${seenOpts[0]?.approvalMode}`);
    check('沙箱取更严格者（用户 workspace-write + 角色 read-only → read-only）',
      seenOpts[0]?.sandboxPolicy === 'read-only', `got=${seenOpts[0]?.sandboxPolicy}`);

    const s12 = makeSender();
    startAgentRun(vp('rp2', { approvalMode: 'on-request', sandboxPolicy: 'read-only', rolePreset: { ...preset, approvalMode: 'auto-safe', sandboxPolicy: 'full-access' } }), s12);
    await sleep(30);
    check('角色审批档不能放宽用户设置（on-request 不被 auto-safe 覆盖）',
      seenOpts[1]?.approvalMode === 'on-request', `got=${seenOpts[1]?.approvalMode}`);
    check('角色沙箱不能放宽用户设置（read-only 不被 full-access 覆盖）',
      seenOpts[1]?.sandboxPolicy === 'read-only', `got=${seenOpts[1]?.sandboxPolicy}`);

    const s13 = makeSender();
    startAgentRun(vp('rp3'), s13);
    await sleep(30);
    check('无 rolePreset 时引擎参数不带该字段（行为与既往一致）',
      seenOpts[2]?.rolePreset === undefined && seenOpts[2]?.approvalMode === 'on-request');
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})();

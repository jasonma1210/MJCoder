// P0-4 主进程 Agent 运行器测试：事件流 / 中止 / 未知 runId / sender 销毁防护 / done 兜底
const { initAgentRunner, startAgentRun, abortRun, abortAllRuns } = require('../main/agentRunner');

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

(async () => {
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
  const res = startAgentRun({ messages: [{ role: 'user', content: 'hi' }], runId: 'r1' }, sender);
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
  startAgentRun({ runId: 'r2' }, s2);
  await sleep(30);
  check('引擎未回调 onDone 时兜底发送 done', s2.events.filter((e) => e.type === 'done').length === 1);

  // ── 引擎抛错 → error 事件 ──
  initAgentRunner({
    loadAgentCore: async () => ({ runAgent: async () => { throw new Error('引擎炸了'); } }),
    createToolHandlers: () => ({}),
  });
  const s3 = makeSender();
  startAgentRun({ runId: 'r3' }, s3);
  await sleep(30);
  check('引擎异常推送 error 事件且含原因', s3.events.some((e) => e.type === 'error' && e.data.includes('引擎炸了')));

  // ── 中止：abortRun 触发 signal ──
  let signalAborted = false;
  initAgentRunner({
    loadAgentCore: async () => ({ runAgent: (opts) => new Promise((resolve) => { opts.signal.addEventListener('abort', () => { signalAborted = true; resolve('已中止'); }); }) }),
    createToolHandlers: () => ({}),
  });
  const s4 = makeSender();
  startAgentRun({ runId: 'r4' }, s4);
  await sleep(10);
  check('abortRun 命中运行中任务', abortRun('r4') === true);
  await sleep(30);
  check('abort 后引擎 signal 置位且正常收尾', signalAborted === true && s4.events.some((e) => e.type === 'done'));
  check('abortRun 对未知 runId 返回 false', abortRun('r-unknown') === false);

  // ── abortAllRuns ──
  const s5 = makeSender();
  const s6 = makeSender();
  startAgentRun({ runId: 'r5' }, s5);
  startAgentRun({ runId: 'r6' }, s6);
  await sleep(10);
  check('abortAllRuns 中止全部挂起运行', abortAllRuns() === 2);
  await sleep(30);
  check('全部运行正常收尾', s5.events.some((e) => e.type === 'done') && s6.events.some((e) => e.type === 'done'));

  // ── sender 已销毁：事件推送不崩溃 ──
  const s7 = makeSender();
  startAgentRun({ runId: 'r7' }, s7);
  s7.destroyed = true;
  await sleep(30);
  check('sender 销毁后事件推送静默跳过（不崩溃）', s7.events.length === 0);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})();

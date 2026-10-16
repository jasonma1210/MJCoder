// T0-4/T0-5 回归门禁：wall-clock 看门狗 + 结构化运行 trace
// 覆盖：模型挂起必超时终止 / 工具挂起计入结构化失败 / 超时表按工具类型覆盖 /
//       重复超时触发既有熔断 / withTimeout 禁用语义 / trace 事件序列与异常隔离
import { runAgent, withTimeout, TOOL_TIMEOUT_OVERRIDES, REPEAT_FAIL_STOP } from '../agent-core/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const model = {
  provider: { id: 1, isGlobal: false, base_url: 'https://example.test/v1' },
  model: { id: 1, model_id: 'test-chat', context_window: 128000 },
};

// chatFn 脚本队列工厂：数组耗尽后重复最后一项（用于「每轮都返回同一工具调用」场景）
function scriptedChat(script, hang = false) {
  let i = 0;
  return async () => {
    if (hang) return new Promise(() => {}); // 永不 resolve：模拟半开连接
    const next = script[Math.min(i, script.length - 1)];
    i += 1;
    return { ...next, usage: next.usage || { prompt_tokens: 5, completion_tokens: 3 } };
  };
}

const shellToolCall = { content: '跑命令', tool_calls: [{ id: 'c1', function: { name: 'shell', arguments: '{"command":"ls"}' } }] };

(async () => {
  // ── 1. 模型调用挂起 → 看门狗在超时点终止整个运行（错误如实冒泡）──
  {
    const t0 = Date.now();
    let err = null;
    const events = [];
    try {
      await runAgent({
        messages: [{ role: 'user', content: 'hi' }], model,
        toolHandlers: { chat: scriptedChat([], true) },
        modelTimeoutMs: 80, chatRetryBaseMs: 0,
        onTrace: (e) => events.push(e),
      });
    } catch (e) { err = e; }
    const ms = Date.now() - t0;
    check('模型挂起被看门狗终止', !!err && /超时/.test(err.message), err ? err.message.slice(0, 60) : '未抛错');
    check('模型超时在配置上限内收尾', ms < 3000, `耗时 ${ms}ms（上限 80ms + 事件循环余量）`);
    const end = events.find((e) => e.type === 'run_end');
    check('异常终止也闭合 run_end（带错误原因）', !!end && /超时/.test(String(end.error || '')), end ? String(end.error).slice(0, 40) : '缺 run_end');
  }

  // ── 2. 工具挂起 → 结构化失败回传模型，运行继续正常收尾 ──
  {
    const toolEvents = [];
    const finalText = await runAgent({
      messages: [{ role: 'user', content: 'hi' }], model,
      toolHandlers: {
        chat: scriptedChat([shellToolCall, { content: '完成' }]),
        shell: () => new Promise(() => {}), // 僵死工具
      },
      toolTimeoutMs: 60, toolTimeouts: {}, chatRetryBaseMs: 0,
      onToolCall: (tc) => toolEvents.push(tc),
    });
    const tc = toolEvents[0];
    check('工具挂起返回超时错误而非卡死', !!tc && /超时/.test(String(tc.result?.error || '')), tc?.result?.error?.slice(0, 50) || '无结果');
    check('工具超时后运行继续并正常收尾', finalText === '完成', `finalText=${JSON.stringify(finalText)}`);
  }

  // ── 3. 超时表按工具类型覆盖：shell 放宽后慢工具不误杀，其余仍受默认档保护 ──
  {
    check('shell 覆盖档存在于默认超时表', TOOL_TIMEOUT_OVERRIDES.shell === 600000 && TOOL_TIMEOUT_OVERRIDES.web_fetch === 60000);
    const toolEvents = [];
    const finalText = await runAgent({
      messages: [{ role: 'user', content: 'hi' }], model,
      toolHandlers: {
        chat: scriptedChat([shellToolCall, { content: '完成' }]),
        // 120ms 的慢命令：默认档 30ms 会误杀，覆盖档 500ms 应放行
        shell: async () => { await new Promise((r) => setTimeout(r, 120)); return { stdout: 'slow-ok', exitCode: 0 }; },
      },
      toolTimeoutMs: 30, toolTimeouts: { shell: 500 }, chatRetryBaseMs: 0,
      onToolCall: (tc) => toolEvents.push(tc),
    });
    check('覆盖档内慢工具不被看门狗误杀', !toolEvents[0]?.result?.error && toolEvents[0]?.result?.stdout === 'slow-ok');
    check('覆盖场景运行正常收尾', finalText === '完成');
  }

  // ── 4. 重复超时 → 走既有重复失败熔断（不空转到轮次硬顶）──
  {
    const t0 = Date.now();
    const finalText = await runAgent({
      messages: [{ role: 'user', content: 'hi' }], model,
      // chat 每轮返回同一 shell 调用（脚本耗尽重复末项）；shell 永远挂起
      toolHandlers: { chat: scriptedChat([shellToolCall]), shell: () => new Promise(() => {}) },
      toolTimeoutMs: 40, toolTimeouts: {}, chatRetryBaseMs: 0,
    });
    const ms = Date.now() - t0;
    check('连续超时触发熔断收尾', /已主动停止/.test(finalText), finalText.slice(0, 60).replace(/\n/g, ' '));
    // REPEAT_FAIL_STOP 次超时即停：远小于轮次硬顶，耗时可上界验证
    check('熔断发生在阈值次数超时后（非轮次硬顶）', ms < 40 * (REPEAT_FAIL_STOP + 2) + 2000, `耗时 ${ms}ms，阈值 ${REPEAT_FAIL_STOP} 次`);
  }

  // ── 5. withTimeout 单元语义 ──
  {
    const v = await withTimeout(Promise.resolve(42), 0, '禁用');
    check('超时 ≤0 视为禁用直接透传', v === 42);
    let hangErr = null;
    try { await withTimeout(new Promise(() => {}), 30, '测试'); } catch (e) { hangErr = e; }
    check('withTimeout 超时抛错含标签', !!hangErr && /测试超时/.test(hangErr.message));
    const ok = await withTimeout(Promise.resolve('x'), 1000, '成功路径');
    check('withTimeout 成功路径不受影响', ok === 'x');
  }

  // ── 6. T0-5 trace：事件序列完整 + 字段齐备 + 回调异常不影响运行 ──
  {
    const events = [];
    const finalText = await runAgent({
      messages: [{ role: 'user', content: 'hi' }], model,
      toolHandlers: {
        chat: scriptedChat([shellToolCall, { content: '完成' }]),
        shell: async () => ({ stdout: 'ok', exitCode: 0 }),
      },
      chatRetryBaseMs: 0,
      onTrace: (evt) => {
        events.push(evt);
        if (evt.type === 'tool') throw new Error('宿主写盘炸了（模拟）'); // 异常必须被引擎吞掉
      },
    });
    const types = events.map((e) => e.type);
    check('运行不受 onTrace 异常影响', finalText === '完成');
    check('trace 含 run_start', types[0] === 'run_start' && events[0].model === 'test-chat');
    check('trace 含逐轮 model 事件', types.filter((t) => t === 'model').length === 2
      && events.find((e) => e.type === 'model').ms >= 0);
    const toolEvt = events.find((e) => e.type === 'tool');
    check('trace 工具事件带名称/轮次/成败', toolEvt?.name === 'shell' && toolEvt?.round === 1 && toolEvt?.failed === false);
    const end = events.find((e) => e.type === 'run_end');
    check('trace run_end 带轮数/用量/终止原因', end?.roundsUsed === 2 && end?.budgetKind === 'normal'
      && typeof end?.usage?.prompt_tokens === 'number' && end?.ms >= 0);
  }

  console.log(`\nagent-watchdog: ${pass}/${pass + fail} 通过`);
  if (fail) process.exitCode = 1;
})();

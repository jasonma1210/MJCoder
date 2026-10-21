// 第八轮 D-805：取消信号穿透到「非流式模型通道」（Worker / 编排 / 定时任务共用同一条）
//
// 缺陷形态（两半，缺一不可）：
//   ① 引擎侧：agent-core 的 resolveChannel 写成 `(args) => handler(args)`，把宿主传来的
//      `{ signal }` 吞掉——少传一个参数不报错，行为静默退化，所以长期没人发现。
//   ② 宿主侧：main.js 的 Worker 工具工厂写 `chat: (payload) => scheduledAgentChat(payload)`，
//      注释却写着「运行中止由池的 controller 级联」——实际只级联到工具层，没级联到模型请求。
// 合起来的症状：**点「停止」对后台任务无效**，在途的那次模型调用要等内部守卫到点（最长 15min）才停。
//
// 本套件锁五件事：
//   ① 取消后**在途请求真的被中止**（不是等它自己结束），且返回形态与交互式通道同款 `{aborted:true}`；
//   ② 排队等 fg 槽位期间取消 → 直接返回，不再发请求（避免「取消了还去排队」）；
//   ③ 取消**不抛错、不记 provider 失败**（取消不是故障，不该进失败复盘）；
//   ④ 未取消时行为零回归（content / tool_calls / usage 原样透出）；
//   ⑤ 内部超时**不得**被误判成取消（两者都走 abort，错误归因必须分清）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createScheduledChannels } = require('../main/scheduledChannels');
const streamSettings = require('../main/streamSettings');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 可编排的假 fetch：默认永不自行结束，只在 signal 被 abort 时 reject（这是「在途请求」的真实形态）
function installFetch(handler) {
  const calls = [];
  global.fetch = (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  return calls;
}

function makeChannels({ quota } = {}) {
  return createScheduledChannels({
    resolveSecret: () => ({ api_key: 'k', base_url: 'https://example.test/v1' }),
    quota: quota || {
      acquire: async () => ({ release() {} }),
      reportSuccess() {}, reportError() {},
    },
  });
}

const neverEnds = (url, init) => new Promise((resolve, reject) => {
  init.signal.addEventListener('abort', () => {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    reject(e);
  });
});

(async () => {
  const realFetch = global.fetch;
  const realTimeouts = streamSettings.getStreamTimeouts;

  // ① 在途请求被真正中止 + 返回形态与交互式同款
  {
    const calls = installFetch(neverEnds);
    const ch = makeChannels();
    const ctl = new AbortController();
    const p = ch.scheduledAgentChat(
      { providerId: 'p', model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      { signal: ctl.signal },
    );
    await new Promise((r) => setTimeout(r, 20));
    check('① 请求确实已发出（先进入在途状态再取消，否则测不到中止）', calls.length === 1);
    const fetchSignal = calls[0].init.signal;
    check('① fetch 收到的 signal 初始未 abort', fetchSignal.aborted === false);
    ctl.abort();
    const res = await p;
    check('① 取消后 fetch 的 signal 变为 aborted（信号真透传到请求层）', fetchSignal.aborted === true);
    check('① 返回 {aborted:true} 而非抛错', res && res.aborted === true);
    check('① finish_reason 标记为 aborted', res.finish_reason === 'aborted');
    check('① 取消不返回任何伪造内容', res.content === '' && Array.isArray(res.tool_calls) && res.tool_calls.length === 0);
    global.fetch = realFetch;
  }

  // ② 排队期间取消 → 不再发请求
  {
    const calls = installFetch(neverEnds);
    const slowQuota = {
      acquire: () => new Promise((resolve) => setTimeout(() => resolve({ release() {} }), 60)),
      reportSuccess() {}, reportError() {},
    };
    const ch = makeChannels({ quota: slowQuota });
    const ctl = new AbortController();
    const p = ch.scheduledAgentChat({ providerId: 'p', model: 'm', messages: [] }, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 10);
    const res = await p;
    check('② 排队期间取消：直接返回 aborted', res.aborted === true);
    check('② 排队期间取消：一次请求都没发（取消了就不该再去排队）', calls.length === 0);
    global.fetch = realFetch;
  }

  // ③ 取消不记 provider 失败（取消不是故障）
  {
    let errCount = 0;
    let okCount = 0;
    const calls = installFetch(neverEnds);
    const ch = makeChannels({
      quota: {
        acquire: async () => ({ release() {} }),
        reportSuccess() { okCount++; }, reportError() { errCount++; },
      },
    });
    const ctl = new AbortController();
    const p = ch.scheduledAgentChat({ providerId: 'p', model: 'm', messages: [] }, { signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 15));
    ctl.abort();
    await p;
    check('③ 取消不进 provider 错误计数', errCount === 0, `reportError=${errCount}`);
    check('③ 取消也不进成功计数（不虚报成功）', okCount === 0, `reportSuccess=${okCount}`);
    global.fetch = realFetch;
    void calls;
  }

  // ④ 未取消时零回归
  {
    installFetch(() => Promise.resolve({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '好的', tool_calls: [] }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    }));
    const ch = makeChannels();
    const ctl = new AbortController();
    const res = await ch.scheduledAgentChat(
      { providerId: 'p', model: 'm', messages: [], reasoningEffort: 'low' },
      { signal: ctl.signal },
    );
    check('④ 正常路径：content 原样返回', res.content === '好的');
    check('④ 正常路径：usage 原样返回', res.usage && res.usage.prompt_tokens === 3);
    check('④ 正常路径：不带 aborted 标记', res.aborted === undefined);
    // reasoning_effort 仍照旧透传（D-805 不得连带改变既有参数口径）
    global.fetch = realFetch;
  }

  // ⑤ 内部超时不得被误判为取消
  {
    installFetch(neverEnds);
    streamSettings.getStreamTimeouts = () => ({ firstByteMs: 10, idleMs: 0, totalMs: 40 });
    const ch = makeChannels();
    // streamGuard 的定时器**刻意 unref**（「不阻止进程退出」），而这里 await 的 promise 自身不持有
    // 任何 handle ⇒ 若不加这个 keep-alive，node 会在定时器触发前就退出，测试**静默半途而废**
    // （表现为「没有失败也没有总结行」）。这类「测试自己跑不完」比红更危险。
    const keepAlive = setTimeout(() => {}, 500);
    let thrown = null;
    try {
      await ch.scheduledAgentChat({ providerId: 'p', model: 'm', messages: [] }); // 无外部 signal
    } catch (e) { thrown = e; }
    clearTimeout(keepAlive);
    check('⑤ 无外部信号时超时仍抛错（不返回 aborted）', !!thrown);
    // 文案口径取自 main/streamGuard.js 的 streamTimeoutMessage（首字节/空闲/总时长三档），
    // 共同特征「已中断本次请求」；关键是否定断言：**不得**被写成取消语义。
    check('⑤ 超时错误沿用 streamGuard 口径（已中断本次请求）',
      !!thrown && /已中断本次请求|总上限|没有收到任何数据/.test(String(thrown.message)),
      thrown ? String(thrown.message).slice(0, 40) : '(无错误)');
    check('⑤ 超时错误不得被写成「取消/aborted」语义',
      !!thrown && !/取消|aborted|cancel/i.test(String(thrown.message)));
    streamSettings.getStreamTimeouts = realTimeouts;
    global.fetch = realFetch;
  }

  // ⑥ 接线：三处缺一即红（宿主工厂 / 引擎通道解析 / 重试链）
  {
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8');
    check('⑥ 宿主 Worker 工厂把 signal 传给模型通道',
      /chat: \(payload\) => scheduledAgentChat\(payload, \{ signal \}\)/.test(mainSrc));

    const coreSrc = fs.readFileSync(path.join(ROOT, 'agent-core/index.js'), 'utf8');
    check('⑥ 引擎 resolveChannel 透传第二参 ctx',
      /\(args, ctx\) => toolHandlers\[camelName\]\(args, ctx\)/.test(coreSrc));
    check('⑥ 引擎重试链把 signal 交给 chatFn',
      /return await chatFn\(params, \{ signal \}\)/.test(coreSrc));
    check('⑥ 反向：不存在「吞掉 ctx」的旧写法（防回退）',
      !/return \(args\) => toolHandlers\[camelName\]\(args\);/.test(coreSrc));
  }

  console.log(`\nscheduled-cancel: ${pass}/${pass + fail} 通过`);
  if (fail > 0) process.exitCode = 1;
})();

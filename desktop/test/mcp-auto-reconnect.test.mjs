#!/usr/bin/env node
// P1-3：MCP 崩溃自动重连调度器的行为门禁（纯 Node，注入假定时器，零网络零成本）
//
// 必须成立的六件事（对应模块头部列出的不变量）：
//   ① crashed 才排程，且首次退避 = base；
//   ② 失败按 base → 2×base → 4×base 指数退避并封顶；
//   ③ 达上限后**停止**（无在途、无新定时器、emit 一次 crashed）——不做无限重连风暴；
//   ④ 幂等：同一服务重复 crashed 只保留一条链；
//   ⑤ 任何非 crashed 状态 / cancel 会撤销在途链（人工优先）；
//   ⑥ reconnect 抛错按一次失败处理（fail-open），继续退避、不冒泡。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { createMcpAutoReconnect } = require(path.join(DESKTOP, 'main/mcpAutoReconnect.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

// 假定时器：记录每次排程的延迟，可手动触发最早一个任务
function makeTimer() {
  let seq = 0;
  const jobs = [];
  return {
    delays: [],
    setTimeout(fn, ms) { const id = ++seq; jobs.push({ id, fn, ms }); this.delays.push(ms); return id; },
    clearTimeout(id) { const i = jobs.findIndex((j) => j.id === id); if (i >= 0) jobs.splice(i, 1); },
    pendingCount() { return jobs.length; },
    async fire() {
      const j = jobs.shift();
      if (!j) throw new Error('无待触发定时器');
      j.fn();
      await flush();
      return j.ms;
    },
  };
}

// ── ① crashed → 排程；重连成功 → emit connected 且链清空 ─────────
{
  const timers = makeTimer();
  const emitted = [];
  let attempts = 0;
  const ar = createMcpAutoReconnect({
    reconnect: async () => { attempts += 1; return { ok: true, toolCount: 3 }; },
    emitStatus: (n, s, c) => emitted.push({ n, s, c }),
    timer: timers, jitter: 0,
  });
  ar.onStatus('svc', 'crashed', 137);
  check('崩溃即排程（1 条在途）', ar.pending().length === 1);
  check('首次退避 = base(2000ms)', timers.delays[0] === 2000, `delay=${timers.delays[0]}`);
  check('排程期间不调用 reconnect（等退避）', attempts === 0);
  await timers.fire();
  check('到点后调用一次 reconnect', attempts === 1, `attempts=${attempts}`);
  check('成功后链被清空', ar.pending().length === 0 && ar.inspect('svc') === null);
  check('成功后 emit connected（供渲染层撤崩溃标记）',
    emitted.length === 1 && emitted[0].n === 'svc' && emitted[0].s === 'connected');
  check('成功后不再排新定时器', timers.pendingCount() === 0);
}

// ── ② 失败 → 指数退避 base → 2base → 4base ─────────
{
  const timers = makeTimer();
  let attempts = 0;
  const ar = createMcpAutoReconnect({
    reconnect: async () => { attempts += 1; return { ok: false, error: 'boom' }; },
    emitStatus: () => {},
    timer: timers, jitter: 0, maxAttempts: 5,
  });
  ar.onStatus('svc', 'crashed', 1);
  await timers.fire(); // 第 1 次失败 → 排下一次
  await timers.fire(); // 第 2 次失败
  await timers.fire(); // 第 3 次失败
  check('连续失败共 3 次尝试', attempts === 3, `attempts=${attempts}`);
  check('退避序列 = 2000 / 4000 / 8000',
    timers.delays[0] === 2000 && timers.delays[1] === 4000 && timers.delays[2] === 8000,
    `delays=${timers.delays.join(',')}`);
}

// ── ③ 达上限后停止（无在途 / 无定时器 / emit 一次 crashed）─────────
{
  const timers = makeTimer();
  const emitted = [];
  let attempts = 0;
  const ar = createMcpAutoReconnect({
    reconnect: async () => { attempts += 1; return { ok: false, error: 'nope' }; },
    emitStatus: (n, s, c) => emitted.push({ n, s, c }),
    timer: timers, jitter: 0, maxAttempts: 3,
  });
  ar.onStatus('svc', 'crashed', 9);
  await timers.fire();
  await timers.fire();
  await timers.fire(); // 第 3 次失败 → attempt=4 > maxAttempts → 耗尽
  check('耗尽后尝试次数 = maxAttempts(3)', attempts === 3, `attempts=${attempts}`);
  check('耗尽后无在途链', ar.pending().length === 0);
  check('耗尽后无遗留定时器（不死循环）', timers.pendingCount() === 0);
  check('耗尽后如实 emit 一次 crashed',
    emitted.filter((e) => e.s === 'crashed').length === 1 && emitted[0].c === 9);
  check('耗尽后不再自动重试（等下一次崩溃才重新开始）', attempts === 3);
}

// ── ④ 幂等：同一服务重复 crashed 只保留一条链 ─────────
{
  const timers = makeTimer();
  const ar = createMcpAutoReconnect({
    reconnect: async () => ({ ok: false, error: 'e' }),
    emitStatus: () => {}, timer: timers, jitter: 0,
  });
  ar.onStatus('svc', 'crashed', 1);
  ar.onStatus('svc', 'crashed', 2);
  check('幂等：只保留 1 条在途链', ar.pending().length === 1);
  check('幂等：只排了 1 个定时器', timers.pendingCount() === 1);
  check('幂等：崩溃码更新为最新', ar.inspect('svc') && ar.inspect('svc').code === 2);
}

// ── ⑤ cancel / 非 crashed 状态撤销在途链 ─────────
{
  const timers = makeTimer();
  const ar = createMcpAutoReconnect({
    reconnect: async () => ({ ok: true }), emitStatus: () => {}, timer: timers, jitter: 0,
  });
  ar.onStatus('svc', 'crashed', 1);
  check('cancel 撤销在途链返回 true', ar.cancel('svc') === true);
  check('cancel 后无在途且无定时器',
    ar.pending().length === 0 && timers.pendingCount() === 0);
  check('cancel 幂等（已无链返回 false）', ar.cancel('svc') === false);

  // 非 crashed 状态（人工重连成功）同样撤销
  ar.onStatus('svc2', 'crashed', 1);
  ar.onStatus('svc2', 'connected', null);
  check('非 crashed 状态撤销在途链',
    ar.pending().length === 0 && timers.pendingCount() === 0);

  // cancelAll 清空所有
  ar.onStatus('a', 'crashed', 1);
  ar.onStatus('b', 'crashed', 1);
  ar.cancelAll();
  check('cancelAll 清空全部链', ar.pending().length === 0 && timers.pendingCount() === 0);
}

// ── ⑥ reconnect 抛错 = 一次失败（fail-open，继续退避）─────────
{
  const timers = makeTimer();
  let attempts = 0;
  const emitted = [];
  const ar = createMcpAutoReconnect({
    reconnect: async () => { attempts += 1; throw new Error('ECONNREFUSED'); },
    emitStatus: (n, s) => emitted.push(s),
    timer: timers, jitter: 0, maxAttempts: 2,
  });
  ar.onStatus('svc', 'crashed', 1);
  await timers.fire(); // 抛错算失败
  check('抛错后仍在退避（已排下一次，未冒泡打断）',
    ar.inspect('svc') != null && ar.inspect('svc').waiting === true && ar.pending().length === 1);
  await timers.fire(); // 第 2 次抛错 → 达上限
  check('抛错达上限后放弃', attempts === 2 && ar.pending().length === 0);
  check('抛错路径同样 emit crashed（报告实情）', emitted.includes('crashed'));
}

// ── ⑦ 抖动与封顶参数生效 ─────────
{
  const t1 = makeTimer();
  const ar1 = createMcpAutoReconnect({
    reconnect: async () => ({ ok: false, error: 'e' }), emitStatus: () => {},
    timer: t1, baseDelayMs: 1000, jitter: 0.5, rand: () => 1,
  });
  ar1.onStatus('s', 'crashed', 1);
  check('抖动按 rand 缩短延迟（1000 × (1-0.5×1) = 500）', t1.delays[0] === 500, `delay=${t1.delays[0]}`);

  const t2 = makeTimer();
  const ar2 = createMcpAutoReconnect({
    reconnect: async () => ({ ok: false, error: 'e' }), emitStatus: () => {},
    timer: t2, baseDelayMs: 2000, maxDelayMs: 5000, jitter: 0, maxAttempts: 4,
  });
  ar2.onStatus('s', 'crashed', 1);
  await t2.fire();
  await t2.fire();
  check('指数退避受 maxDelayMs 封顶（8000 → 5000）', t2.delays[2] === 5000, `delays=${t2.delays.join(',')}`);
}

console.log(`\nmcp-auto-reconnect: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;

#!/usr/bin/env node
// 任务级模型回归（2026-10-18）
//
// 需求：定时任务里能单独选模型（输入框下面那个下拉），不选则跟随会话模型。
// 守三条：
//   ① 存的是**快照**（providerId/isGlobal/baseUrl/model），不是引用 —— 运行时 provider 可能已被删
//   ② 任务有模型就用它，跟会话当前模型无关（这正是不再"被切模型带跑"的关键）
//   ③ 快照形状不全/已过期 → 回落会话模型，**不能让任务永久跑不动**
// .mjs 里没有 require：先在文件最前面装 createRequire，后续照常 require
const { createRequire: createReq } = await import('node:module');
const require = createReq(import.meta.url);
const assert = require('node:assert/strict');

let pass = 0;
let total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// electron stub（scheduler 顶层 require electron，纯 node 下需要）
const Module = require('module');
const handlers = new Map();
const noop = () => {};
const electronPath = require.resolve('electron');
const stub = new Module(electronPath, null);
stub.filename = electronPath;
stub.loaded = true;
stub.exports = {
  app: { getPath: () => '/tmp/mjcode-task-model', whenReady: () => Promise.resolve(), on: noop },
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), once: noop, on: noop },
};
require.cache[electronPath] = stub;

const scheduler = require('../main/scheduler.js');
const { normalizeTaskModel } = scheduler;

const A = { providerId: 'p-a', isGlobal: false, baseUrl: 'https://a.example', model: 'model-a' };
const B = { providerId: 'p-b', isGlobal: true, baseUrl: 'https://b.example', model: 'model-b' };

(async () => {
  await check('快照归一：完整形状原样保留', () => {
    assert.deepEqual(normalizeTaskModel(A), A);
  });
  await check('快照归一：缺 providerId 或 model 一律视为「未指定」', () => {
    assert.equal(normalizeTaskModel({ model: 'm' }), null);
    assert.equal(normalizeTaskModel({ providerId: 'p' }), null);
    assert.equal(normalizeTaskModel(null), null);
    assert.equal(normalizeTaskModel('p::m'), null);
  });
  await check('快照归一：去掉首尾空格，isGlobal 强制布尔', () => {
    assert.deepEqual(normalizeTaskModel({ providerId: ' p ', model: ' m ', isGlobal: 1 }), {
      providerId: 'p', model: 'm', isGlobal: true, baseUrl: '',
    });
  });

  // ── 运行时优先级：任务模型 > 会话模型 ──
  const seen = [];
  scheduler.startScheduler({ runAgentTask: async ({ model }) => { seen.push(model); return { output: 'ok', toolCalls: 0 }; }, taskTimeoutMs: 5000 });
  scheduler.setModel(B);

  const withModel = scheduler.createTask({ name: '带模型', prompt: 'x', schedule: '0 9 * * *', model: A });
  await check('createTask 保存模型快照', () => {
    assert.deepEqual(withModel.task.model, A);
  });
  await scheduler.runTask(withModel.task.id, 'manual');
  await check('任务指定了模型 → 用它，不用会话模型', () => {
    assert.equal(seen.at(-1).model, 'model-a');
  });

  const noModel = scheduler.createTask({ name: '不指定', prompt: 'x', schedule: '0 9 * * *' });
  await check('未指定模型 → 字段为 null（跟随会话）', () => {
    assert.equal(noModel.task.model, null);
  });
  await scheduler.runTask(noModel.task.id, 'manual');
  await check('未指定模型 → 回落会话当前模型', () => {
    assert.equal(seen.at(-1).model, 'model-b');
  });

  // ── 过期快照：回落而不是报错 ──
  const broken = scheduler.createTask({ name: '坏模型', prompt: 'x', schedule: '0 9 * * *', model: A });
  broken.task.model = { model: 'only-model-no-provider' }; // 模拟被写坏的快照
  const r = await scheduler.runTask(broken.task.id, 'manual');
  await check('快照形状不全 → 回落会话模型并跑通（不因坏配置永久停摆）', () => {
    assert.equal(r.ok, true);
    assert.equal(seen.at(-1).model, 'model-b');
  });

  // startScheduler 会起 20s 轮询，不关掉进程永不退出（run-all 会按 180s 超时判崩溃）
  scheduler.stopScheduler();
  console.log(`\nscheduled-task-model: ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})();

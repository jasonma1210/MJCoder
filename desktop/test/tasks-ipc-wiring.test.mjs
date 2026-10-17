// X14 回归门禁：tasks:* IPC 的「deps 契约 + V04 治理快照」接线。
//
// 为什么必须单独测（2026-10-18 连续两次同型事故）：
//   把 tasks:* 从 main.js 搬进 ipc/tasks.js 时，两次都在**搬运收口**上出错——
//     ① `main.js` 里 `toolOrchestrateTask` 的 hostPolicySnapshot 调用点没跟着改 → ReferenceError；
//     ② `initTasksIpc({...})` 的 deps 漏了 getApprovalMode → `deps.getApprovalMode is not a function`。
//   两次都是「静态语法 PASS、应用能启动、冒烟测试全绿」，只有真跑一次该通道才炸。
//   静态门禁（lint no-undef / ipc-write-guard-coverage）覆盖不到 deps 契约，只能靠行为断言：
//   这里用假 deps 真调一次 handlers —— 接线漏一个字段就会当场 TypeError。
//
// 同时锁定 V04 治理快照的两个分支（有 cwd → workspace-write，无 cwd → read-only）与审批档来源，
// 这是「子任务不得在用户设『全部询问』时自动放行」的唯一保障。
//
// ⚠ 本文件的盲区（2026-10-18 经评审指出后已补静态断言，留档说明为什么需要那条）：
//   下面所有行为用例传的是**本文件自己的假 deps**，因此只能证明「ipc/tasks.js 会去取 deps.X」，
//   **证明不了 main.js 真的传了 X** —— 而事故 ② 恰恰是 main.js 那一侧漏传。
//   故文件末尾另有一条静态断言：tasks.js 里出现的每个 `deps.X` 都必须在 main.js 的
//   `initTasksIpc({...})` 调用里出现（U ⊆ P）。那条才是事故 ② 的直接守门员。
//
// MUTATION（这条测试有没有牙的自查法，改动后请照做一次）：
//   删掉 main.js `initTasksIpc({...})` 里的 `getApprovalMode: () => agentRunner.getCurrentApprovalMode(),`
//   → 期望「static: main.js 的 initTasksIpc 调用覆盖了 tasks.js 用到的全部 deps 键」变红；
//   再删掉本文件 deps 对象的 `getApprovalMode` → 期望「tasks:autoRun 真调一次不抛」变红（TypeError）。
//   两条都红才是有效门禁；只红一条说明只覆盖了单侧。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Module from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}
async function checkAsync(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// ── electron stub：只捕获 ipcMain.handle 注册的处理器 ──
const handlers = new Map();
const electronPath = require.resolve('electron');
const stubModule = new Module(electronPath, null);
stubModule.filename = electronPath;
stubModule.loaded = true;
stubModule.exports = { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } };
require.cache[electronPath] = stubModule;

const tasksIpc = require(path.join(DESKTOP, 'main/ipc/tasks.js'));

// ── 假 deps：故意做成「只有该有的字段」，漏一个就 TypeError ──
const calls = { orchestrate: [], plan: [], runGroup: [], events: [] };
let approvalModeFromUser = 'always';
const deps = {
  getTaskStore: () => ({ __fake: true }),
  getLocalStore: () => ({ setPreference: () => {} }),
  getApprovalMode: () => approvalModeFromUser,
  emitTaskEvent: (evt) => calls.events.push(evt),
  orchestrator: {
    autoOrchestrate: async (args) => { calls.orchestrate.push(args); return { ok: true, groupId: 'g-auto' }; },
    planGoal: async (args) => { calls.plan.push(args); return { ok: true, groupId: 'g-plan' }; },
  },
  workerPool: {
    runGroup: async (gid) => { calls.runGroup.push(gid); return { group_id: gid }; },
    abortTask: () => true,
    abortGroup: () => 1,
    schedule: () => {},
    setMaxConcurrent: (n) => n,
  },
};
tasksIpc.initTasksIpc(deps);

const call = (channel, payload) => handlers.get(channel)({}, payload);

await checkAsync('tasks:autoRun 真调一次不抛（deps 契约完整：漏 getApprovalMode 会当场 TypeError）', async () => {
  const r = await call('tasks:autoRun', { goal: '整理本周提交', cwd: '/tmp/proj', conversationId: 'c1' });
  if (!r?.ok) throw new Error(`返回 ${JSON.stringify(r)}`);
});

await check('tasks:autoRun 的 V04 快照：有 cwd → workspace-write + 用户当前审批档', () => {
  const args = calls.orchestrate[0];
  if (args.sandboxPolicy !== 'workspace-write') throw new Error(`sandboxPolicy=${args.sandboxPolicy}`);
  if (args.approvalMode !== 'always') throw new Error(`approvalMode=${args.approvalMode}（未取到用户档）`);
  if (args.threadId !== 'c1') throw new Error(`threadId=${args.threadId}`);
  if (args.goal !== '整理本周提交') throw new Error(`goal=${args.goal}`);
});

await checkAsync('tasks:autoRun 无 cwd → read-only（漏判等于给子任务无隔离写权限）', async () => {
  await call('tasks:autoRun', { goal: '只读分析' });
  const args = calls.orchestrate[1];
  if (args.sandboxPolicy !== 'read-only') throw new Error(`sandboxPolicy=${args.sandboxPolicy}`);
  if (args.threadId !== null) throw new Error(`缺 conversationId 时应为 null，实际 ${args.threadId}`);
});

await checkAsync('tasks:plan 走同一套快照与校验', async () => {
  approvalModeFromUser = 'never';
  const r = await call('tasks:plan', { goal: '拆解目标', cwd: '/tmp/p' });
  if (!r?.ok) throw new Error(`返回 ${JSON.stringify(r)}`);
  const args = calls.plan[0];
  if (args.approvalMode !== 'never') throw new Error(`approvalMode=${args.approvalMode}`);
  if (args.sandboxPolicy !== 'workspace-write') throw new Error(`sandboxPolicy=${args.sandboxPolicy}`);
  approvalModeFromUser = 'on-request';
});

await checkAsync('tasks:autoRun 载荷非法 → 信封拒绝且不触达编排器（X14 边界校验）', async () => {
  const before = calls.orchestrate.length;
  const r = await call('tasks:autoRun', { cwd: '/tmp/p' });
  if (r?.ok !== false) throw new Error(`缺 goal 竟被放行：${JSON.stringify(r)}`);
  if (!String(r.error).includes('goal')) throw new Error(`错误未指出字段名：${r.error}`);
  if (calls.orchestrate.length !== before) throw new Error('非法载荷仍触达了 orchestrator');
});

await checkAsync('tasks:execute 复用 taskGroupRefSchema（缺 groupId 被拒）', async () => {
  const ok = await call('tasks:execute', { groupId: 'g-1' });
  if (!ok?.ok || calls.runGroup[0] !== 'g-1') throw new Error(`合法载荷失败：${JSON.stringify(ok)}`);
  const bad = await call('tasks:execute', {});
  if (bad?.ok !== false) throw new Error(`缺 groupId 竟被放行：${JSON.stringify(bad)}`);
  const badType = await call('tasks:execute', { groupId: 123 });
  if (badType?.ok !== false) throw new Error(`数字 groupId 竟被放行：${JSON.stringify(badType)}`);
});

await check('注册的通道集合与期望**完全相等**（不只是"都存在"——多注册/拼错名同样要红）', () => {
  const expected = ['tasks:autoRun', 'tasks:plan', 'tasks:execute', 'tasks:list', 'tasks:get',
    'tasks:cancel', 'tasks:abortTask', 'tasks:abortGroup', 'tasks:retryTask', 'tasks:deleteGroup', 'tasks:config'];
  const actual = [...handlers.keys()].sort();
  const missing = expected.filter((c) => !actual.includes(c));
  const extra = actual.filter((c) => !expected.includes(c));
  if (missing.length) throw new Error(`未注册：${missing.join(', ')}`);
  if (extra.length) throw new Error(`多出未列入清单的通道（改名/拼错？）：${extra.join(', ')}`);
});

// ── 静态：deps 契约两侧对齐（这条才是事故 ② 的直接守门员）──
// 行为用例只能证明 tasks.js 会取 deps.X；能否取到取决于 main.js 有没有传。
// 故直接比对两侧集合：U = tasks.js 里出现的 deps.X，P = main.js initTasksIpc 调用里传的键。
await check('static: main.js 的 initTasksIpc 调用覆盖了 tasks.js 用到的全部 deps 键', () => {
  const tasksSrc = fs.readFileSync(path.join(DESKTOP, 'main/ipc/tasks.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(DESKTOP, 'main/main.js'), 'utf8');
  // U：任务模块实际取用的依赖键（排除注释里的说明行）
  const used = new Set();
  for (const m of tasksSrc.matchAll(/\bdeps\.([A-Za-z_$][\w$]*)/g)) used.add(m[1]);
  if (used.size === 0) throw new Error('未在 tasks.js 里匹配到任何 deps.X（正则失效？）');
  // P：main.js 里 initTasksIpc({...}) 的实参键
  const call = mainSrc.match(/initTasksIpc\(\{[\s\S]*?\n\}\);/);
  if (!call) throw new Error('未找到 main.js 的 initTasksIpc({...}) 调用（结构变化请同步本测试）');
  const passed = new Set();
  for (const m of call[0].matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*[:,]/gm)) passed.add(m[1]);
  if (passed.size === 0) throw new Error('未解析出 initTasksIpc 的实参键（正则失效？）');
  const missing = [...used].filter((k) => !passed.has(k));
  if (missing.length) {
    throw new Error(`main.js 漏传 deps 键：${missing.join(', ')}（tasks.js 会用 deps.${missing[0]} 取值，运行期 TypeError）`);
  }
  // 反向：传了但没人用的键是噪音，同样提示（不致命，但会让"契约"逐渐失真）
  const unused = [...passed].filter((k) => !used.has(k));
  if (unused.length) throw new Error(`main.js 传了 tasks.js 未使用的键：${unused.join(', ')}（契约漂移）`);
});

console.log(`\ntasks-ipc-wiring: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);

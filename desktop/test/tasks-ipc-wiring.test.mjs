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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Module from 'node:module';

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

await check('初始化后全部 tasks:* 通道都已注册（漏注册 = 渲染层调用落到 capabilityUnavailable）', () => {
  const expected = ['tasks:autoRun', 'tasks:plan', 'tasks:execute', 'tasks:list', 'tasks:get',
    'tasks:cancel', 'tasks:abortTask', 'tasks:abortGroup', 'tasks:retryTask', 'tasks:deleteGroup', 'tasks:config'];
  const missing = expected.filter((c) => typeof handlers.get(c) !== 'function');
  if (missing.length) throw new Error(`未注册：${missing.join(', ')}`);
});

console.log(`\ntasks-ipc-wiring: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);

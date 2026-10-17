// 任务编排域 IPC（tasks:*）——从 main.js 原样搬移，只在 tasks:autoRun / tasks:plan 上加了边界校验。
//
// 为什么抽出来（X14）：tasks 域有独立边界（11 条通道 + 载荷契约入口），且本批次要在 tasks:* 上
// 加载荷校验。**不是**因为「main.js 快撞 1500 行」——那个门禁按去空行注释的 code 行数算，
// 搬前 raw 1496 而 eslint 实计只有 1093，仍有 407 行余量（见 main/main.js 顶部说明）。
// 这块与编排器 / Worker 池只有「调用」关系——编排状态与初始化仍留 main.js，
// 故用 getter 注入（与 main/ipc/localData.js、main/ipc/mcp.js 同款 initXxx(deps) 模式）。
//
// X14 载荷校验取舍：
//   · tasks:autoRun / tasks:plan 此前直接解构 { goal, cwd, conversationId }，畸形输入会一路走到
//     编排器才失败或误入分支 → 进业务前用 payloadGuard 校验形状与上限（信封型返回值，失败转 {ok:false}）；
//   · tasks:execute 复用既有 zod 契约（taskGroupRefSchema）——它和 tasks:cancel 是同一个「组引用」
//     载荷，另写一套 assert 只会造成两套规则漂移；
//   · tasks:cancel / abortTask / abortGroup / retryTask / deleteGroup / config 原本就有 zod 契约，不再重复。
const { ipcMain } = require('electron');
const guard = require('./payloadGuard');
let deps = null;

// ── D2（2026-10-16）：任务写通道（tasks:*）载荷契约 ──
// tasks:* 是改任务状态 / 恢复暂停组 / 删除任务组的**写通道**；此前直接解构载荷，
// 畸形输入会走到 store 层才失败或误入分支。现把形状固化为 zod schema，进业务逻辑前校验。
// 主进程 CJS 无法同步 require ESM（Electron 33 / Node 20），故沿用动态 import + ready 门。
let taskPayloads = null;
const taskPayloadsReady = import('../../shared-ipc/taskPayloads.mjs')
  .then((m) => { taskPayloads = m; })
  .catch((e) => { console.error('[tasks] 载荷契约加载失败（写通道将拒绝请求，fail-closed）:', e.message); });

/** 校验 tasks:* 写通道载荷。契约不可用或载荷不合法时返回 {ok:false}，调用方据此拒绝执行。 */
async function validateTaskPayload(schemaName, payload) {
  await taskPayloadsReady;
  if (!taskPayloads) return { ok: false, error: 'tasks 写通道载荷契约不可用（fail-closed）' };
  return taskPayloads.parseIpcPayload(taskPayloads[schemaName], payload);
}

// V04：宿主治理快照（审批档 + 沙箱档）的唯一事实来源在 main/approvalPolicy.js（纯函数、零依赖）——
// 本模块与模型侧 orchestrate_task 工具各自 import，绝不在此另写一份。
const { hostPolicySnapshot } = require('../approvalPolicy');

/** X14：guard 抛出的 PayloadError 转成该通道既有的信封（tasks:* 调用方一律读 r.ok） */
function payloadRejection(payload, spec) {
  try {
    guard.assertStrings(payload, spec);
    return null;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function register() {
  ipcMain.handle('tasks:autoRun', async (_, payload = {}) => {
    const taskStore = deps.getTaskStore();
    if (!taskStore) return { ok: false, error: '任务编排子系统不可用（初始化失败）' };
    // X14：goal 是模型提示词、cwd 会落盘并作为 Worker 工作目录——边界先把形状与长度守住
    const bad = payloadRejection(payload, {
      goal: 20000,
      cwd: { max: 1024, optional: true, allowEmpty: true },
      conversationId: { max: 200, optional: true, allowEmpty: true },
    });
    if (bad) return bad;
    const { goal, cwd, conversationId } = payload;
    // 一键自动：拆解（失败自动修复重试）→ 直接执行；组失败后由 orchestrator 自动重规划
    // R6：组绑定发起会话（threadId）——渲染层任务面板按会话归属显示
    return deps.orchestrator.autoOrchestrate({ goal, cwd, threadId: conversationId || null, ...hostPolicySnapshot(cwd, deps.getApprovalMode()) });
  });

  ipcMain.handle('tasks:plan', async (_, payload = {}) => {
    const taskStore = deps.getTaskStore();
    if (!taskStore) return { ok: false, error: '任务编排子系统不可用（初始化失败）' };
    // X14：同 tasks:autoRun——拆解入口的载荷同样直接进模型上下文
    const bad = payloadRejection(payload, {
      goal: 20000,
      cwd: { max: 1024, optional: true, allowEmpty: true },
      conversationId: { max: 200, optional: true, allowEmpty: true },
    });
    if (bad) return bad;
    const { goal, cwd, conversationId } = payload;
    return deps.orchestrator.planGoal({ goal, cwd, threadId: conversationId || null, ...hostPolicySnapshot(cwd, deps.getApprovalMode()) });
  });

  ipcMain.handle('tasks:execute', async (_, payload) => {
    const taskStore = deps.getTaskStore();
    if (!taskStore) return { ok: false, error: '任务编排子系统不可用' };
    // X14：组引用载荷与 tasks:cancel 同构，直接复用 zod 契约（不另写一套 assert）
    const v = await validateTaskPayload('taskGroupRefSchema', payload);
    if (!v.ok) return v;
    const { groupId } = v.data;
    try {
      const g = await deps.workerPool.runGroup(groupId);
      return { ok: true, group: g };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('tasks:list', async (_, opts) => {
    const taskStore = deps.getTaskStore();
    return taskStore ? { ok: true, groups: taskStore.listGroups(opts) } : { ok: false, error: '不可用' };
  });

  ipcMain.handle('tasks:get', async (_, { groupId } = {}) => {
    const taskStore = deps.getTaskStore();
    return taskStore ? { ok: true, group: taskStore.getGroup(groupId) } : { ok: false, error: '不可用' };
  });

  ipcMain.handle('tasks:cancel', async (_, payload) => {
    const taskStore = deps.getTaskStore();
    if (!taskStore) return { ok: false, error: '不可用' };
    const v = await validateTaskPayload('taskGroupRefSchema', payload);
    if (!v.ok) return v;
    const { groupId } = v.data;
    try {
      // v1：仅允许取消未在执行的组（ready/paused）；running 组等收尾或用任务级重试干预
      const g = taskStore.getGroup(groupId);
      if (!g) return { ok: false, error: '任务组不存在' };
      if (g.status === 'running') return { ok: false, error: '组执行中，暂不支持取消；请等待收尾后处理' };
      return { ok: true, group: taskStore.setGroupStatus(groupId, 'cancelled') };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 强制关闭正在执行的子任务（Agent 面板入口）：中止运行且不重试
  ipcMain.handle('tasks:abortTask', async (_, payload) => {
    const taskStore = deps.getTaskStore();
    if (!taskStore) return { ok: false, error: '不可用' };
    const v = await validateTaskPayload('taskRefSchema', payload);
    if (!v.ok) return v;
    const { groupId, taskId } = v.data;
    const done = deps.workerPool.abortTask(groupId, taskId);
    return done ? { ok: true } : { ok: false, error: '该任务不在执行中（可能已完成或尚未开始）' };
  });

  // 组级强停（对话中止联动 / 胶囊面板「全部停止」）
  ipcMain.handle('tasks:abortGroup', async (_, payload) => {
    const taskStore = deps.getTaskStore();
    if (!taskStore) return { ok: false, error: '不可用' };
    const v = await validateTaskPayload('taskGroupRefSchema', payload);
    if (!v.ok) return v;
    const n = deps.workerPool.abortGroup(v.data.groupId);
    return { ok: true, aborted: n };
  });

  ipcMain.handle('tasks:retryTask', async (_, payload) => {
    const taskStore = deps.getTaskStore();
    if (!taskStore) return { ok: false, error: '不可用' };
    // D2：进业务逻辑前先校验载荷（不合法即拒绝，不触碰任何任务状态）
    const v = await validateTaskPayload('taskRetryPayloadSchema', payload);
    if (!v.ok) return v;
    const { groupId, taskId, confirmReview } = v.data;
    try {
      const t = taskStore.getTask(groupId, taskId);
      if (!t) return { ok: false, error: '子任务不存在' };
      if (t.status !== 'failed') return { ok: false, error: `仅失败任务可重试（当前：${t.status}）` };
      // A5（2026-10-16）：重试前置「副作用核对」。
      // 该任务上次运行若在产生副作用后被中断（写文件 / 发请求 / 装包），其副作用状态记为
      // uncertain（见 taskStore.markEffectUncertain）——重试会**再执行一次**同一批操作，
      // 可能重复写入或重复提交。因此存在未确认副作用时必须由用户显式确认（confirmReview=true）。
      const uncertain = typeof taskStore.listUncertainEffects === 'function'
        ? taskStore.listUncertainEffects(groupId)
        : [];
      if (taskStore.needsRetryReview(groupId, taskId, confirmReview)) {
        return {
          ok: false,
          requiresReview: true,
          groupId,
          taskId,
          uncertainEffects: uncertain,
          message: '该任务上次运行留下了未确认的副作用（可能已写入文件或发出请求）。'
            + '重试会再次执行同一批操作，请先核对工作区改动后再确认。',
        };
      }
      taskStore.setTaskStatus(groupId, taskId, 'queued');
      const g = taskStore.getGroup(groupId);
      if (g.status === 'paused') taskStore.setGroupStatus(groupId, 'running'); // paused → running（重试续跑）
      deps.workerPool.schedule();
      return { ok: true, group: taskStore.getGroup(groupId) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('tasks:deleteGroup', async (_, payload) => {
    const taskStore = deps.getTaskStore();
    if (!taskStore) return { ok: false, error: '不可用' };
    const v = await validateTaskPayload('taskGroupRefSchema', payload);
    if (!v.ok) return v;
    const { groupId } = v.data;
    // R6（用户实测反馈）：任务组可删除——终态/暂停组从面板消失，不留僵尸记录
    const r = taskStore.deleteGroup(groupId);
    if (r.ok) deps.emitTaskEvent({ type: 'group_deleted', groupId });
    return r;
  });

  ipcMain.handle('tasks:config', async (_, payload) => {
    const v = await validateTaskPayload('taskConfigPayloadSchema', payload);
    if (!v.ok) return v;
    const n = deps.workerPool.setMaxConcurrent(v.data.maxConcurrent);
    deps.getLocalStore()?.setPreference('tasks.max_concurrent', n);
    return { ok: true, maxConcurrent: n };
  });
}

// deps: { getTaskStore, getLocalStore, getApprovalMode, emitTaskEvent, orchestrator, workerPool }
function initTasksIpc(d) {
  deps = d;
  register();
}

module.exports = { initTasksIpc, validateTaskPayload };

// M5 / T5-11：成员持久会话（设计稿 v1.5 §13.1 C1 / §13.2 四级 key / §13.3）——Worker 侧会话键、
// 确定性成员指派、成员断点读写。
//
// 从 workerPool.js 抽出（2026-10-20）的原因：补上「认领者落库 + 断点恢复 + 完成落断点」后
// 该文件越过 800 行软档（God File 黄线）。本族方法自洽可搬：
//   · memberSessionKey   —— 会话键（军团组 agent:{memberId}；无名册组隔离命名空间）；
//   · pickOwnerMember    —— 名册 + task.seq 取模的纯函数指派（无映射表）；
//   · read/saveMemberCheckpoint —— 复用 checkpointStore（同一存储 / 同一清理入口 / 同一 50 条 LRU）。
//
// 依赖注入：{ getCheckpoint?, saveCheckpoint? } —— 单测注入假存储以断言键位；生产缺省回落
// checkpointStore 单例（主进程启动时已 initCheckpointStore(userData)）。
const checkpointStore = require('./checkpointStore');

const MEMBER_SESSION_PREFIX = 'agent:';

// 会话键（§13.2 四级 key 的末级）：memberId ↔ sessionId 的确定性映射，**不加列、不迁移**。
// 无名册组（非军团编排）回落 `agent:anon:{groupId}:{taskId}`：与原一次性 `task:` 键同语义
//（一次性隔离、不跨 run 复用），但前缀统一收敛，避免两套命名空间。
function memberSessionKey(group, task) {
  const memberId = String(task?.ownerMemberId || '').trim();
  if (memberId) return `${MEMBER_SESSION_PREFIX}${memberId}`;
  return `${MEMBER_SESSION_PREFIX}anon:${group.group_id}:${task.taskId}`;
}

// 确定性成员指派（T5-12 之前的最小实现）：团队名册按 created_at ASC（teamStore.getTeam 口径），
// 序号取 task.seq 取模。纯函数 —— 不落映射表、不依赖运行期状态，重放同组同一任务必得同一成员。
function pickOwnerMember(roster, task) {
  const list = (Array.isArray(roster) ? roster : []).filter((m) => m && m.id);
  if (!list.length) return null;
  const seq = Number(task?.seq);
  const idx = Number.isFinite(seq) && seq > 0 ? Math.trunc(seq) % list.length : 0;
  return String(list[idx].id);
}

/**
 * 成员断点读写门面。
 * @param {{getCheckpoint?: Function, saveCheckpoint?: Function}} deps 可覆写（单测注入假存储）
 */
function createMemberSession(deps = {}) {
  // 成员断点落库（§13.1 C1「worker 侧补从成员断点恢复」的另一半：普通完成路径也要落断点）。
  // 此前 Worker 通道**从不**碰断点（仅在主对话链路的预算熔断 / 超时 / 引擎退出三处落库），
  // 成员会话因此永远「记不住」。threadId 一并落库 = 四级 key 链在工作侧可见（§13.2）：
  // 由断点即可反查「该成员最近一次工作属于哪个对话的哪个 run」。
  // fail-open：断点是垫脚石不是结果，写失败绝不改任务成败判定。
  function save(sessionKey, group, task, result) {
    try {
      const write = typeof deps.saveCheckpoint === 'function'
        ? deps.saveCheckpoint : checkpointStore.saveCheckpoint;
      write(sessionKey, {
        kind: 'member-task',
        // 成员工作记录形态（见 read 注释：引擎恢复段是固定文案，需与此衔接）
        summary: `成员工作记录：子任务「${task.title || task.taskId}」已收尾。\n${String(result?.summary || '').slice(0, 5000)}`,
        threadId: group.thread_id || null,
        runId: group.group_id,
        taskId: task.taskId,
        ownerMemberId: task.ownerMemberId || null,
        cwd: group.cwd || '',
      });
    } catch (e) {
      console.warn('[workerPool] 成员断点保存失败（不影响任务结果）:', e.message);
    }
  }

  // 成员断点读取（跨 run 复用，§13.3）。裁剪上限与 agent-core 的注入上限一致（6000 字符），
  // 避免「这里放 2 万字、那里只注入 6000」的隐性截断。
  //
  // 与引擎恢复段的衔接（**保持 L2 引擎零改动**，§13.6）：engine 的恢复段是固定文案
  // 「上一任务因预算触顶暂停……已完成部分不要重做」，且整段经 wrapUntrusted 隔离为数据。
  // 故此处把断点渲染成**成员工作记录**（事实陈述），与「已完成部分不要重做」一致；
  // 「待办」由本轮的 runOpts.messages（新子任务提示词）给出——两段不冲突。
  function read(sessionKey) {
    try {
      const load = typeof deps.getCheckpoint === 'function'
        ? deps.getCheckpoint : checkpointStore.getCheckpoint;
      const cp = load(sessionKey);
      const summary = String(cp?.summary || '').trim();
      return summary ? summary.slice(0, 6000) : '';
    } catch (e) {
      console.warn('[workerPool] 成员断点读取失败（本轮不带断点运行）:', e.message);
      return '';
    }
  }

  return { memberSessionKey, pickOwnerMember, save, read };
}

module.exports = {
  MEMBER_SESSION_PREFIX, memberSessionKey, pickOwnerMember, createMemberSession,
};

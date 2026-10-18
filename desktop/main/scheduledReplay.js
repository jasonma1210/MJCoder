'use strict';
// 「待确认动作」的重放执行器（清单的一键执行）。
//
// 三条硬约束，缺一条都会变成事故：
//   1. **幂等**：id 由 guard 生成（`runId#序号`），非 pending 一律拒绝 —— 双击不能提交两次。
//   2. **重放前重新校验**：审批是「允许执行某个动作」，不是永久豁免校验。8 小时前记下的
//      commit，现在重放很可能把别人后来的改动一起提交。HEAD 变了就判 stale，让人重跑任务。
//   3. **只重放可重放子集**：git/shell 自带 cwd 且不需要会话上下文；MCP / PR 类依赖外部
//      鉴权与会话，盲目重放等于绕开原来的授权路径，一律标记为「需人工」。
const { REPLAYABLE, readHead } = require('./scheduledGuard');

const HANDLER_OF = { git_commit: 'gitCommit', git_add: 'gitAdd', shell: 'shell' };

/**
 * createScheduledReplay({ getHandlers })
 *   getHandlers() 必须返回**未被闸门包装**的原始工具表（重放本身就是人工批准后的执行）。
 * 返回 async ({ action, cwd }) → { ok, code, error, stdout }
 *   code ∈ ok | failed | stale | manual | not_pending | no_cwd | no_handler
 */
function createScheduledReplay({ getHandlers } = {}) {
  return async function replay({ action, cwd } = {}) {
    if (!action || typeof action !== 'object') return { ok: false, code: 'not_pending', error: '动作不存在' };
    if (action.status !== 'pending') {
      return { ok: false, code: 'not_pending', error: '该动作已处理过（同一动作不能执行两次）' };
    }
    const tool = String(action.tool || '');
    if (!REPLAYABLE.has(tool)) {
      return { ok: false, code: 'manual', error: '该动作依赖原始会话上下文，请手工执行' };
    }
    const dir = String(action.cwd || cwd || '');
    if (!dir) return { ok: false, code: 'no_cwd', error: '缺少工作目录，无法重放' };
    // 前置条件重新校验（HITL 规范：批准≠永久豁免校验）
    const headNow = readHead(dir);
    if (action.head && headNow && headNow !== action.head) {
      return {
        ok: false, code: 'stale',
        error: `工作区已变化（HEAD ${String(action.head).slice(0, 7)} → ${headNow.slice(0, 7)}），请重跑任务而不是直接重放`,
      };
    }
    let handlers;
    try {
      handlers = typeof getHandlers === 'function' ? getHandlers() : {};
    } catch (e) {
      return { ok: false, code: 'no_handler', error: `执行器不可用：${String(e?.message || e)}` };
    }
    const fn = handlers && handlers[HANDLER_OF[tool]];
    if (typeof fn !== 'function') return { ok: false, code: 'no_handler', error: '执行器不可用' };
    try {
      // requireApproval:false —— 用户点「执行」就是这次批准，不能再弹一次卡（也没有人值守）
      const res = await fn({ ...(action.args || {}), cwd: dir, requireApproval: false });
      const exitBad = typeof res?.exitCode === 'number' && res.exitCode !== 0;
      const failed = !!res?.error || exitBad;
      return {
        ok: !failed,
        code: failed ? 'failed' : 'ok',
        error: failed ? String(res?.error || res?.stderr || `退出码 ${res?.exitCode}`).slice(0, 500) : '',
        stdout: String(res?.stdout || '').slice(0, 4000),
      };
    } catch (e) {
      return { ok: false, code: 'failed', error: String(e?.message || e).slice(0, 500) };
    }
  };
}

module.exports = { createScheduledReplay, HANDLER_OF };

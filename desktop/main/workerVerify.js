// Worker 通道的 V 层（评估接口）装配 —— 从 workerPool 抽出（2026-10-21）
//
// 抽出的直接原因：workerPool 已逼近 800 行软档，而 B-02（组级预算闸）必须在它里面加调用点。
// 按本项目纪律「白名单只减不增、先拆再合入」，正确做法是把一块**内聚的既有逻辑**搬出去，
// 而不是给 workerPool 加白名单、也不是把注释删薄充数。
//
// 这块逻辑的内聚性：全部是「Worker 通道的 V 层怎么配」——判定事实来源、默认档位、L3 风险门。
// 与「怎么调度任务」无关，属评估层策略。搬走后 workerPool 只剩一行调用。
//
// 语义与抽走前**逐字等价**（这不是重构改造，是搬家）：
//   · 判定事实来源 = ledger（引擎 verify_ledger，经 runWorkerTask 的 onTrace 收）
//     + diff（runCwd 的 git status；非 git 工作区返回 null → R5 降级 SKIP，不阻断任务）。
//   · 默认档 l1（P1-2 由 off 升 l1：子任务此前无任何对账，只靠主任务兜底）。
//   · L3 由 deps.getVerifyConfig() 显式下发 level='l3' 才可能触发（与定时通道同策略）。

'use strict';

const verifyRun = require('./verifyRun');
const verifyPolicy = require('./verifyPolicy');

/**
 * 建立 Worker 通道的验证运行。
 *
 * @param {object} ctx
 * @param {object} ctx.deps      workerPool 的依赖包（读 l3Target / getVerifyConfig）
 * @param {string} ctx.runKey    `${groupId}/${taskId}`
 * @param {string} ctx.sessionKey 成员会话键（`agent:{memberId}` 或 anon 兜底）
 * @param {string} ctx.runCwd    本任务的执行目录（worktree 或主目录）
 * @returns {object} verifyRun 的运行句柄（onToolCall / onLedger 由调用方接线）
 */
function createWorkerVerifyRun({ deps = {}, runKey, sessionKey, runCwd } = {}) {
  const l3 = typeof deps.l3Target === 'function' ? (deps.l3Target() || {}) : {};
  return verifyRun.createVerificationRun({
    runId: `worker:${runKey}`,
    conversationId: sessionKey,
    cwd: runCwd || '',
    config: (typeof deps.getVerifyConfig === 'function' ? deps.getVerifyConfig() : null),
    // Worker 无 agent:event 通道；结果只进 trace + verdicts.jsonl
    emit: null,
    defaultLevel: 'l1',
    l3Chat: l3.l3Chat || null,
    l3Model: l3.l3Model || null,
    l3Gate: (ctx2) => verifyPolicy.shouldRunL3({ ...ctx2, trigger: { risk: true, sampleRate: 0 } }),
  });
}

module.exports = { createWorkerVerifyRun };

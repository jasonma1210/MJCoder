'use strict';
// 定时任务通道的 V 层装配（把「判定引擎」和「触发策略」接到无人值守链路上）。
//
// 设计要点（对应 2026-10-18 的行业调研结论）：
//   1. L1 确定性对账**全量必跑**：零网络、零边际成本，没有理由关。
//   2. L3 独立评审**按需付费**：只有命中风险门（本轮产生了对外/不可逆动作）或抽样命中才跑，
//      并且用便宜的 compact 档模型 —— guardrail 本质是分类任务，不需要前沿模型。
//   3. 无人值守 **fail-closed**：请求了 L3 却没拿到有效判定，或守卫型 L3 判 FLAG，
//      一律不得宣告成功（产物照常归档，供早上人工复核）。
//   4. 抽样型 L3 只用于度量，**不降级交付** —— 抽样是测量，风险门才是守卫，不能混。
//
// 与主对话通道的差异只有第 3 条：主对话人就在屏幕前，判不出来放行更合理。
const verifyRun = require('./verifyRun');
const verifyPolicy = require('./verifyPolicy');

// 5% 抽样：用于持续度量「低风险任务里 L3 会不会也说证据不足」。
// 不设更高：抽样是成本，风险门已经覆盖了真正会伤人的那批。
const DEFAULT_SAMPLE_RATE = 0.05;

/**
 * createScheduledVerify({ taskId, cwd, level, trigger, l3Chat, l3Model, rand })
 *   → { enabled, level, onTrace, onToolCall, finish(output) }
 *   finish 返回 { verify, delivery }：
 *     verify   —— { level, verdict, reason, annotation, l3:{...} }，原样进运行记录
 *     delivery —— { downgrade, reason }，downgrade=true 时调用方不得标 success
 */
function createScheduledVerify({
  taskId = '', cwd = '', level = 'l3', trigger = null,
  l3Chat = null, l3Model = null, rand = Math.random,
} = {}) {
  const gateTrigger = trigger && typeof trigger === 'object'
    ? { risk: true, sampleRate: DEFAULT_SAMPLE_RATE, ...trigger }
    : { risk: true, sampleRate: DEFAULT_SAMPLE_RATE };

  const vrun = verifyRun.createVerificationRun({
    runId: `scheduled:${taskId || 'unknown'}`,
    conversationId: 'scheduled',
    cwd: cwd || '',
    config: { level },
    // 定时任务没有 agent:event 通道（无人值守没人看），结果只进 trace 与运行记录。
    // 这一点与 workerPool 一致：不要为了「有个事件」而开一条没人消费的通道。
    emit: null,
    defaultLevel: level,
    l3Chat,
    l3Model,
    // 触发闸门：只在 l3 档位下才有意义（l1 时 verifyRun 根本不会问它）
    l3Gate: (ctx) => verifyPolicy.shouldRunL3({ ...ctx, trigger: gateTrigger, rand }),
  });

  return {
    enabled: vrun.enabled,
    level: vrun.level,
    /** 引擎 onTrace：只收父 run 的台账（子代理事件 sub:true 属于子 run，不计入本任务） */
    onTrace: (evt) => {
      if (!evt || evt.sub) return false;
      return vrun.onLedger(evt);
    },
    onToolCall: (tc) => vrun.onToolCall(tc),
    async finish(output) {
      let r;
      try {
        r = await vrun.finish(output);
      } catch (e) {
        // V 层自身异常不得影响任务：按「未验证」处理（fail-closed 下会降级交付）
        return {
          verify: { level: vrun.level, verdict: 'SKIP', reason: `verify_error: ${String(e?.message || e).slice(0, 200)}`, annotation: '', l3: null },
          delivery: { downgrade: true, reason: 'V 层执行异常，无人值守按未验证处理' },
        };
      }
      const verify = {
        level: r.level || vrun.level,
        verdict: r.verdict || 'SKIP',
        reason: String(r.reason || '').slice(0, 600),
        annotation: String(r.annotation || '').slice(0, 2000),
        l3: r.l3 || null,
      };
      return { verify, delivery: verifyPolicy.decideDelivery({ verify, failClosed: true }) };
    },
  };
}

/**
 * L3 独立评审用的模型与通道（从 main.js 抽出，避免 main 行数门禁逼着写丑代码）。
 * 优先分档的 compact 槽（便宜档：guardrail 本质是分类任务），未配置或形状不全则跟随主模型。
 * 用非流式单轮通道（chatOnce）：评审不需要工具，也不需要流式。
 * 返回一个工厂函数：调用时再解析（配置可能在运行期变更，且启动早期 model 尚未就绪）。
 */
function createScheduledL3Target({ resolveModel, getModelOverrides, chatOnce } = {}) {
  return () => {
    try {
      const ov = (typeof getModelOverrides === 'function' ? getModelOverrides() || {} : {}).compact;
      const base = typeof resolveModel === 'function' ? resolveModel() : null;
      // 分档槽位形状不全（缺 providerId/model）时**回落主模型**：与 workerPool 同一纪律，
      // 否则一个坏配置会让每次「有对外动作」的定时任务都判成未验证（fail-closed 放大故障）。
      const m = (ov && ov.model && ov.providerId)
        ? { providerId: ov.providerId, isGlobal: !!ov.isGlobal, baseUrl: ov.baseUrl || '', model: ov.model }
        : base;
      if (!m || !m.model || typeof chatOnce !== 'function') return {};
      return {
        l3Model: m.model,
        l3Chat: (p) => chatOnce({ messages: p.messages }, {
          providerId: m.providerId, isGlobal: !!m.isGlobal, baseUrl: m.baseUrl || '', model: m.model,
        }),
      };
    } catch (e) {
      console.warn('[scheduled] L3 评审目标解析失败（将按未注入处理）:', e.message);
      return {};
    }
  };
}

module.exports = { createScheduledVerify, createScheduledL3Target, DEFAULT_SAMPLE_RATE };

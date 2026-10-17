'use strict';
// 定时任务 / 子代理的非流式模型通道（2026-10-17 从 main.js 抽出）。
//
// 抽出理由有两个，缺一不可：
//   1) main.js 已顶到 1500 行硬门禁（抽前 1542），新增功能必须落独立模块；
//   2) 这两条通道与主交互链路（chatStreamOnce）是并列关系——它们不流式、不带审批、
//      不直接面向用户，职责上本来就不该和 UI 通道挤在一个文件里。
//
// 语义要点：非流式请求**没有 idle 可言**（响应体到齐前没有任何中间数据可观察），
// 所以这里只启用「首字节 + 单轮总时长」两层；拿"空闲"判断会把"正在生成"当成"挂死"。
// 要享受空闲语义，就得把这两条也改成流式（留作后续）。

const { createStreamGuard, streamTimeoutMessage } = require('./streamGuard');
const streamSettings = require('./streamSettings');

function createScheduledChannels({ resolveSecret, quota } = {}) {
  if (typeof resolveSecret !== 'function') throw new Error('createScheduledChannels: 缺少 resolveSecret');
  if (!quota) throw new Error('createScheduledChannels: 缺少 quota');

  /** 三层超时（用户设置 > 环境变量 > 默认），每次请求现读 */
  const resolveStreamTimeouts = () => streamSettings.getStreamTimeouts();

  function guardFor() {
    const t = resolveStreamTimeouts();
    const controller = new AbortController();
    const guard = createStreamGuard({
      firstByteMs: t.firstByteMs,
      idleMs: 0, // 非流式：没有中间数据可观察
      totalMs: t.totalMs,
      onFire: () => controller.abort(),
    });
    guard.start();
    return { guard, controller };
  }

  // 定时任务执行通道：非流式单轮直连（凭证解析与 model:chat 同源）
  // 模型由渲染层 scheduled:setModel 推送（跟随用户当前选择）；未推送时拒绝执行并给出明确错误
  async function scheduledChatOnce({ messages }, model) {
    const secret = resolveSecret(model.providerId, !!model.isGlobal);
    if (!secret || !secret.api_key) {
      throw new Error('KEY_MISSING: 模型凭证未加载，请在模型设置中重新填写 API Key');
    }
    const root = (model.baseUrl || secret.base_url || '').replace(/\/+$/, '');
    if (!root) throw new Error('BASE_URL_MISSING: 模型服务地址为空');
    const { guard, controller } = guardFor();
    try {
      const res = await fetch(`${root}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret.api_key}` },
        body: JSON.stringify({ model: model.model, messages, stream: false }),
        signal: controller.signal,
      });
      guard.firstByte();
      if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j = await res.json();
      return j.choices?.[0]?.message?.content || '';
    } catch (err) {
      const fired = guard.reason();
      if (fired) throw new Error(streamTimeoutMessage(fired, guard.config()));
      throw err;
    } finally {
      guard.stop();
    }
  }

  // 非流式 + 工具调用（OpenAI 兼容）：agent-core chatFn 契约
  async function scheduledAgentChat(payload) {
    const secret = resolveSecret(payload.providerId, !!payload.isGlobal);
    if (!secret || !secret.api_key) {
      throw new Error('KEY_MISSING: 模型凭证未加载，请在模型设置中重新填写 API Key');
    }
    const root = (payload.baseUrl || secret.base_url || '').replace(/\/+$/, '');
    if (!root) throw new Error('BASE_URL_MISSING: 模型服务地址为空');
    // P3-2：fg 槽位预占——Worker / 编排 / 记忆后台 compress 均经此通道，统一占用 fg 槽位
    const slot = await quota.acquire('fg', payload.providerId || 'default');
    const body = { model: payload.model, messages: payload.messages, stream: false };
    if (Array.isArray(payload.tools) && payload.tools.length > 0) {
      body.tools = payload.tools;
      body.tool_choice = 'auto';
    }
    const { guard, controller } = guardFor();
    try {
      const res = await fetch(`${root}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret.api_key}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      guard.firstByte();
      if (!res.ok) {
        quota.reportError(payload.providerId || 'default');
        throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const j = await res.json();
      quota.reportSuccess(payload.providerId || 'default');
      const choice = j.choices?.[0] || {};
      const m = choice.message || {};
      return {
        content: m.content || '',
        tool_calls: (m.tool_calls || []).map((tc) => ({
          id: tc.id, type: 'function',
          function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '{}' },
        })),
        usage: j.usage ? { prompt_tokens: j.usage.prompt_tokens || 0, completion_tokens: j.usage.completion_tokens || 0 } : null,
        finish_reason: choice.finish_reason || null,
      };
    } catch (err) {
      const fired = guard.reason();
      if (fired) {
        quota.reportError(payload.providerId || 'default');
        throw new Error(streamTimeoutMessage(fired, guard.config()));
      }
      throw err;
    } finally {
      guard.stop();
      slot.release();
    }
  }

  return { scheduledChatOnce, scheduledAgentChat };
}

module.exports = { createScheduledChannels };

// 模型参数的两种形状 —— 全项目唯一转换事实来源
//
// 事故背景（2026-10-15 真机）：自动 DAG（orchestrate_task）的每个子任务第 1 轮即崩，
// 报 `Cannot read properties of undefined (reading 'id')`。根因是本项目里 model 对象
// 存在两套形状，且各调用链手抄转换、逐步漂移：
//
//   扁平形 { providerId, isGlobal, baseUrl, model, cwd? }
//     —— 模型设置/定时任务/编排器/聊天通道（chatStreamOnce、scheduledAgentChat）使用
//   嵌套形 { provider: { id, isGlobal, base_url }, model: { model_id, context_window } }
//     —— agent-core 的 runAgent / compactHistory / decomposeTask 使用
//
// 定时任务路径在 main.js 里手写过一次扁平→嵌套转换，Worker 路径（workerPool.js）漏了，
// 直接把 resolveTaskModel() 的扁平对象喂给 runAgent → model.provider 为 undefined
// → 第 3 方看不懂的 TypeError，被引擎当成「模型调用失败」记日志后降级。
//
// 修法：转换逻辑只此一份，三条调用链统一引用；任何形状都能进，出参形状由调用点决定。
// 新增调用链时只需 require 本模块，不复写转换——从结构上杜绝再次漂移。

const DEFAULT_CONTEXT_WINDOW = 128000;

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// 判定是否为嵌套形（以 provider 子对象存在为准；扁平形的顶层 providerId 与之互斥）
function isNested(m) {
  return isPlainObject(m) && isPlainObject(m.provider);
}

/**
 * 任一形状 → 嵌套形（agent-core runAgent 的契约）。
 * @param {object} m  扁平形或嵌套形
 * @returns {{provider: {id: string, isGlobal: boolean, base_url: string}, model: {model_id: string, context_window: number}}}
 * @throws 形状不可用（缺 providerId 或 model_id）时抛明确错误，而不是让下游抛
 *         `Cannot read properties of undefined`。
 */
function toAgentModel(m) {
  if (!isPlainObject(m)) {
    throw new Error('模型参数无效：需要对象，实为 ' + typeof m);
  }
  if (isNested(m)) {
    // 已是嵌套形：只补齐缺省字段，不动原值
    return {
      provider: {
        id: m.provider.id ?? '',
        isGlobal: !!m.provider.isGlobal,
        base_url: m.provider.base_url || '',
      },
      model: {
        model_id: m.model?.model_id ?? '',
        context_window: Number(m.model?.context_window) > 0
          ? Number(m.model.context_window) : DEFAULT_CONTEXT_WINDOW,
      },
    };
  }
  const modelId = String(m.model || '');
  if (!modelId) {
    throw new Error('模型参数无效：缺少 model（扁平形需提供 model 字段，嵌套形需提供 model.model_id）');
  }
  return {
    provider: {
      id: m.providerId ?? '',
      isGlobal: !!m.isGlobal,
      base_url: m.baseUrl || '',
    },
    model: {
      model_id: modelId,
      context_window: Number(m.contextWindow) > 0 ? Number(m.contextWindow) : DEFAULT_CONTEXT_WINDOW,
    },
  };
}

/**
 * 任一形状 → 扁平形（聊天通道 chatStreamOnce / scheduledAgentChat 的契约）。
 */
function toChatRequest(m) {
  if (!isPlainObject(m)) return { providerId: '', isGlobal: false, baseUrl: '', model: '' };
  if (isNested(m)) {
    return {
      providerId: m.provider.id ?? '',
      isGlobal: !!m.provider.isGlobal,
      baseUrl: m.provider.base_url || '',
      model: m.model?.model_id ?? '',
    };
  }
  return {
    providerId: m.providerId ?? '',
    isGlobal: !!m.isGlobal,
    baseUrl: m.baseUrl || '',
    model: m.model ?? '',
  };
}

/**
 * 校验 agent-core 收到的 model 是否可用，不可用时抛**可诊断**的错误。
 * 目的是把 `Cannot read properties of undefined (reading 'id')` 这类无信息量的
 * TypeError 挡在入口，换成指明缺哪个字段、期望哪种形状的消息。
 */
function assertAgentModel(m) {
  if (!isPlainObject(m)) {
    throw new Error('模型参数无效：需要对象，实为 ' + typeof m);
  }
  if (!isPlainObject(m.model) || !m.model.model_id) {
    throw new Error('模型参数形状错误：缺少 model.model_id（期望嵌套形 { provider:{id,base_url}, model:{model_id} }）');
  }
  if (!isPlainObject(m.provider)) {
    throw new Error('模型参数形状错误：缺少 provider 对象（期望嵌套形 { provider:{id,base_url}, model:{model_id} }；'
      + '若为扁平形 { providerId, baseUrl, model }，请先用 toAgentModel() 转换）');
  }
  return true;
}

module.exports = {
  toAgentModel, toChatRequest, assertAgentModel, isNested, DEFAULT_CONTEXT_WINDOW,
};

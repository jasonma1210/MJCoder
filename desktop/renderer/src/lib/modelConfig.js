// 模型级配置（思考强度 / 上下文窗口），localStorage 持久化，按 provider+model 定位
// 结构：{ [modelKey]: { reasoning_effort: ''|'low'|'medium'|'high', context_window: 0|number } }
// '' / 0 表示跟随服务端默认（不下发参数）

const STORE_KEY = 'mj_model_configs';

export const REASONING_EFFORT_OPTIONS = [
  { value: '', label: '默认' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

export const CONTEXT_WINDOW_OPTIONS = [
  { value: 0, label: '默认' },
  { value: 32768, label: '32K' },
  { value: 65536, label: '64K' },
  { value: 131072, label: '128K' },
  { value: 262144, label: '256K' },
  { value: 1048576, label: '1M' },
];

export function modelKeyOf(provider, model) {
  const p = provider ? `${provider.isGlobal ? 'g' : provider.source || 'u'}:${provider.id}` : 'none';
  const m = model ? (model.model_id || model.id) : 'none';
  return `${p}/${m}`;
}

function loadAll() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch (e) {
    console.warn('[modelConfig] 解析失败，回落空配置');
    return {};
  }
}

export function getModelConfig(key) {
  if (!key) return null;
  return loadAll()[key] || null;
}

export function setModelConfig(key, patch) {
  if (!key) return;
  const all = loadAll();
  all[key] = { ...(all[key] || {}), ...patch };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch (e) {
    console.warn('[modelConfig] 持久化失败:', e);
  }
}

// 上下文窗口取值优先级：用户覆盖 > 模型自带 > 兜底 128K
export function effectiveContextWindow(provider, model) {
  const cfg = getModelConfig(modelKeyOf(provider, model));
  return cfg?.context_window || model?.context_window || 128000;
}

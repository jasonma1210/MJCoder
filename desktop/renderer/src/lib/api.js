// 数据访问层：服务端 API 与本地存储（离线模式）双轨路由
// 服务端地址优先级：localStorage mj_api_base（历史覆盖）→ 主进程偏好 server.apiBase（设置-通用）
// → env MJ_SERVER_API（主进程侧）→ 默认本机 3001
let API = (typeof localStorage !== 'undefined' && localStorage.getItem('mj_api_base'))
  || 'http://localhost:3001/api';

export function getApiBase() { return API; }
export function setApiBase(b) {
  const v = String(b || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(v) || v === API) return;
  API = v;
  try { localStorage.setItem('mj_api_base', API); } catch { /* 隐私模式等场景尽力而为 */ }
}

// 启动同步：主进程偏好是打包版唯一可用的服务端地址入口（env 经 Finder 启动不可达）
if (typeof window !== 'undefined' && window.mjcode?.serverBase) {
  window.mjcode.serverBase().then((r) => { if (r?.base) setApiBase(r.base); }).catch(() => {});
}

let localMode = false;
export function setLocalMode(v) { localMode = !!v; }
export function isLocalMode() { return localMode; }

// 功能开关快照（云端委派 / 小程序控制面），默认全关（fail-closed）
let featureFlags = { cloud: false, miniprogram: false };
export function getFeatures() { return featureFlags; }
export async function loadFeatures() {
  try {
    const r = await fetch(`${API}/health`);
    const j = await r.json();
    if (j && j.features) featureFlags = { ...featureFlags, ...j.features };
  } catch {
    // 服务不可达时保持默认关闭（fail-closed）
  }
  return featureFlags;
}

function getToken() {
  return localStorage.getItem('mj_token');
}

async function request(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getToken()}`,
      ...options.headers,
    },
  });
  if (res.status === 401) {
    localStorage.removeItem('mj_token');
    window.dispatchEvent(new Event('auth-changed'));
    throw new Error('Unauthorized');
  }
  return res.json();
}

// ── 离线模式本地路由 ──
async function localThreads(projectPath) {
  return window.mjcode.localThreads(projectPath ? { projectPath } : {});
}

async function localCreateThread(data) {
  return window.mjcode.localCreateThread({
    title: data.title, cwd: data.cwd, projectPath: data.project_path || data.cwd || '',
    providerId: data.provider_id, providerName: data.provider_name, modelName: data.model_name,
  });
}

async function localMessages(id) {
  return window.mjcode.localMessages({ threadId: id });
}

async function localSendMessage(id, data) {
  return window.mjcode.localAddMessage({
    threadId: id,
    role: data.role, content: data.content,
    toolCalls: data.tool_calls || null, toolCallId: data.tool_call_id || null,
    tokensInput: data.tokens_input || 0, tokensOutput: data.tokens_output || 0,
    modelName: data.model_name,
  });
}

async function localProviders() {
  const list = await window.mjcode.localProviders();
  // 与服务端结构对齐：models 由多模型数组派生；对未迁移的旧结构（仅 modelId）做容错回落
  return list.map((p) => ({
    ...p,
    source: 'local',
    models: (p.models || (p.modelId ? [{ modelId: p.modelId, displayName: p.modelId }] : []))
      .map((m) => ({ id: m.modelId, model_id: m.modelId, display_name: m.displayName || m.modelId })),
  }));
}

// 服务端私有 provider：id 加 s 前缀做命名空间隔离，避免与本机 provider id 冲突
function markServerProviders(list) {
  return (list || []).map((p) => ({ ...p, id: `s${p.id}`, source: 'server' }));
}

// 底层错误中文可读化：UI 禁止直接暴露 Failed to fetch 一类原始英文错误
export function humanizeError(err) {
  const raw = String((err && err.message) || err || '未知错误');
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(raw)) {
    return '无法连接本地服务（localhost:3001），已改由本机数据库处理';
  }
  if (raw === 'Unauthorized') return '登录状态已失效，请重新登录或切换到离线模式';
  return raw;
}

export const api = {
  // Auth（离线模式不支持账户操作）
  register: (data) => request('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
  login: (data) => request('/auth/login', { method: 'POST', body: JSON.stringify(data) }),
  // 微信小程序绑定确认（M5 控制面）：桌面端输入小程序展示的绑定码完成关联
  confirmMpBind: (bindCode) => request('/auth/mp-confirm', { method: 'POST', body: JSON.stringify({ bindCode }) }),

  // Threads（projectPath 用于「项目 → 任务」二级筛选）
  threads: (projectPath) => (localMode
    ? localThreads(projectPath)
    : request(projectPath ? `/threads?project=${encodeURIComponent(projectPath)}` : '/threads')),
  createThread: (data) => (localMode ? localCreateThread(data) : request('/threads', { method: 'POST', body: JSON.stringify(data) })),
  setThreadStatus: (id, status) => (localMode
    ? window.mjcode.localSetThreadStatus({ id, status })
    : request(`/threads/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) })),
  messages: (id) => (localMode ? localMessages(id) : request(`/threads/${id}/messages`)),
  sendMessage: (id, data) => (localMode ? localSendMessage(id, data) : request(`/threads/${id}/messages`, { method: 'POST', body: JSON.stringify(data) })),
  // /compact 落库：压缩摘要整体替换消息历史（仅本地模式；服务端无替换路由）
  replaceMessages: (id, messages) => {
    if (!localMode) return Promise.reject(new Error('在线模式下压缩结果暂不持久化（仅本地模式生效）'));
    return window.mjcode.localReplaceMessages({ threadId: id, messages });
  },
  deleteThread: (id) => (localMode ? window.mjcode.localDeleteThread({ threadId: id }) : request(`/threads/${id}`, { method: 'DELETE' })),
  // A1：会话重命名（本地 + 服务端双轨）
  renameThread: (id, title) => (localMode
    ? window.mjcode.localRenameThread({ threadId: id, title })
    : request(`/threads/${id}/title`, { method: 'PUT', body: JSON.stringify({ title }) })),
  // A3：归档管理（本地能力；服务端删除同为归档语义，恢复走本地通道）
  archivedThreads: () => (localMode
    ? window.mjcode.localArchivedThreads()
    : Promise.reject(new Error('归档管理需离线模式或等待服务端支持'))),
  restoreThread: (id) => window.mjcode.localRestoreThread({ threadId: id }),
  purgeThread: (id) => window.mjcode.localPurgeThread({ threadId: id }),
  // B1：会话归组到项目（本地通道）
  setThreadProject: (id, projectPath) => window.mjcode.localSetThreadProject({ threadId: id, projectPath }),

  // Providers（私有凭证一律落本机数据库：localStore + safeStorage 加密，密钥不出本机）
  // 在线模式额外追加服务端私有 provider（id 带 s 前缀）；服务端不可达时静默降级为纯本机列表
  providers: async () => {
    const local = await localProviders();
    if (localMode) return local;
    try {
      return [...local, ...markServerProviders(await request('/providers'))];
    } catch (err) {
      console.warn('[api] 服务端模型列表不可达，降级为本机列表:', err.message);
      return local;
    }
  },
  addProvider: (data) => window.mjcode.localAddProvider({
    name: data.name, base_url: data.base_url, api_key: data.api_key, model_id: data.model_id || '',
  }),
  addModel: (pid, data) => (String(pid).startsWith('s')
    ? request(`/providers/${String(pid).slice(1)}/models`, { method: 'POST', body: JSON.stringify(data) })
    : window.mjcode.localSetProviderModel({ id: pid, model_id: data.model_id })),
  // 多模型：本机 provider 模型条目增删（服务端无删除路由，仅本机支持）
  addProviderModel: (pid, data) => (String(pid).startsWith('s')
    ? request(`/providers/${String(pid).slice(1)}/models`, { method: 'POST', body: JSON.stringify(data) })
    : window.mjcode.localAddProviderModel({ id: pid, model_id: data.model_id, display_name: data.display_name })),
  removeProviderModel: (pid, modelId) => (String(pid).startsWith('s')
    ? Promise.reject(new Error('服务端共享模型不支持在本机删除'))
    : window.mjcode.localRemoveProviderModel({ id: pid, model_id: modelId })),
  deleteProvider: (id) => (String(id).startsWith('s')
    ? request(`/providers/${String(id).slice(1)}`, { method: 'DELETE' })
    : window.mjcode.localDeleteProvider({ id })),
  // B2：供应商编辑（仅本机 provider；服务端 provider 名称/地址由服务端管理）
  updateProvider: (id, data) => (String(id).startsWith('s')
    ? Promise.reject(new Error('服务端共享模型不支持在本机编辑'))
    : window.mjcode.localUpdateProvider({ id, name: data.name, base_url: data.base_url, api_key: data.api_key })),
  // B2：测试连接（本机 provider 由主进程内存解析 Key）
  testConnection: (id, baseUrl) => window.mjcode.testConnection({ id, base_url: baseUrl }),

  // Server-side global providers（离线不可用）
  globalProviders: () => fetch(`${API}/global/providers`).then(r => r.json()),

  // Preferences
  preferences: () => (localMode ? Promise.resolve({}) : request('/preferences')),
  updatePreferences: (data) => (localMode ? window.mjcode.localSetPreference({ key: 'preferences', value: data }) : request('/preferences', { method: 'PUT', body: JSON.stringify(data) })),

  // Scheduled tasks：桌面端本地调度器优先（离线可用，主进程 20s 轮询 cron 到点执行）；
  // 无本地通道（旧构建/浏览器调试）时回落服务端 /scheduled-tasks
  scheduledTasks: async () => {
    if (window.mjcode?.scheduledList) return (await window.mjcode.scheduledList()).tasks;
    return request('/scheduled-tasks');
  },
  createScheduledTask: (data) => (window.mjcode?.scheduledSave
    ? window.mjcode.scheduledSave({ enabled: true, ...data })
    : request('/scheduled-tasks', { method: 'POST', body: JSON.stringify(data) })),
  updateScheduledTask: (id, data) => (window.mjcode?.scheduledSave
    ? window.mjcode.scheduledSave({ id, ...data })
    : request(`/scheduled-tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) })),
  deleteScheduledTask: (id) => (window.mjcode?.scheduledDelete
    ? window.mjcode.scheduledDelete({ id })
    : request(`/scheduled-tasks/${id}`, { method: 'DELETE' })),
  runScheduledTask: (id) => (window.mjcode?.scheduledRun
    ? window.mjcode.scheduledRun({ id })
    : request(`/scheduled-tasks/${id}/run`, { method: 'POST' })),
  scheduledTaskRuns: async (id) => {
    if (window.mjcode?.scheduledRuns) return (await window.mjcode.scheduledRuns({ id })).runs;
    return request(`/scheduled-tasks/${id}/runs`);
  },

  // Audit log（服务端功能，离线不可用）
  auditLog: () => request('/audit'),

  // Dashboard（离线降级：返回本地统计）
  dashboard: async () => {
    if (!localMode) return request('/dashboard');
    const threads = await window.mjcode.localThreads();
    let messages = [];
    for (const t of threads) messages = messages.concat(await window.mjcode.localMessages({ threadId: t.id }));
    return {
      threads: threads.length,
      messages: messages.length,
      tokens_input: messages.reduce((s, m) => s + (m.tokensInput || 0), 0),
      tokens_output: messages.reduce((s, m) => s + (m.tokensOutput || 0), 0),
      model_distribution: [],
      recent_activity: [],
      weekly_threads: [],
    };
  },
};

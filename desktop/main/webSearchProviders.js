// web_search 配置工程收口（2026-10-15）
//
// 背景：web_search 工具早已建成，但默认无任何端点 → 一调用就报 web_search_unconfigured，
// 只剩 env 变量一条配置路径且无 UI。审查定性为「能力已建」与「开箱可用」之间最典型的落差。
//
// 本模块职责：
//   1) 内置主流搜索提供方元数据（是否需要 Key / 申请入口 / 说明），供设置页渲染与校验；
//   2) 配置读写（localStore 偏好持久化 + 旧 env 变量向后兼容）；
//   3) 各提供方的请求构造与响应解析（纯函数，可单测）；
//   4) 多提供方按序 failover：可全开也可只开一个，第一个成功者生效，全部失败回报明细。
//
// 安全基线：所有出网走 webTools.httpRequest（SSRF 防护单一实现），本模块不绕过。
const { httpRequest } = require('./webTools');

// ── 提供方元数据（设置页据此渲染，顺序即默认优先级）──
const SEARCH_PROVIDERS = [
  {
    id: 'tavily', label: 'Tavily', requiresKey: true,
    keyLabel: 'TAVILY_API_KEY', keyPlaceholder: 'tvly-...',
    docsUrl: 'https://app.tavily.com/home',
    note: '为 Agent 设计的搜索 API，返回干净正文摘要；免费额度每月 1000 次。',
  },
  {
    id: 'duckduckgo', label: 'DuckDuckGo', requiresKey: false,
    keyLabel: '', keyPlaceholder: '',
    docsUrl: 'https://duckduckgo.com',
    note: '无需 Key，开箱可用（HTML 解析，结果质量一般但零配置零成本）。',
  },
  {
    id: 'searxng', label: 'SearXNG（自托管）', requiresKey: false,
    keyLabel: '', keyPlaceholder: '',
    docsUrl: 'https://docs.searxng.org',
    note: '自托管元搜索，需填实例地址（extra.endpoint），实例须开启 JSON 输出。',
  },
  {
    id: 'brave', label: 'Brave Search', requiresKey: true,
    keyLabel: 'BRAVE_API_KEY', keyPlaceholder: 'BSA...',
    docsUrl: 'https://api-dashboard.search.brave.com/app/keys',
    note: '独立索引，免费额度每月 2000 次。',
  },
  {
    id: 'exa', label: 'Exa', requiresKey: true,
    keyLabel: 'EXA_API_KEY', keyPlaceholder: '',
    docsUrl: 'https://dashboard.exa.ai/api-keys',
    note: '语义检索，适合查技术文档与论文。',
  },
  {
    id: 'bing', label: 'Bing Search', requiresKey: true,
    keyLabel: 'Ocp-Apim-Subscription-Key', keyPlaceholder: '',
    docsUrl: 'https://portal.azure.com',
    note: 'Azure 认知服务；需订阅密钥。',
  },
  {
    id: 'google', label: 'Google CSE', requiresKey: true,
    keyLabel: 'GOOGLE_API_KEY', keyPlaceholder: '',
    docsUrl: 'https://programmablesearchengine.google.com/controlpanel/all',
    note: '需同时配置可编程搜索引擎 ID（cx / extra.engineId）。',
    extraFields: [{ id: 'engineId', label: '搜索引擎 ID（cx）', placeholder: '例：017576662512468239146:omuauf_lfve' }],
  },
  {
    id: 'baidu', label: '百度', requiresKey: false,
    keyLabel: '', keyPlaceholder: '',
    docsUrl: 'https://www.baidu.com',
    note: '解析网页结果，无需 Key；百度有反爬策略，可能偶发失败（会自动落到下一家）。',
  },
];

const PROVIDER_IDS = SEARCH_PROVIDERS.map((p) => p.id);
const PREF_KEY = 'web_search.providers';
const DEFAULT_TIMEOUT_MS = 12000;

// ── 配置读写 ──
// 形状：[{ id, enabled, apiKey, extra:{endpoint?, engineId?} }]
// 向后兼容：旧 env（MJCODE_WEB_SEARCH_ENDPOINT/KEY）映射为一个 searxng/tavily 之外的
// 通用「自定义端点」条目不现实（响应结构未知），故 env 只在**完全无配置**时提示仍在，
// 不再参与请求构造——避免「UI 配了 A、env 里还有个旧 B」时的双源混乱。
function loadSearchConfig(localStore, credentialCrypto = null) {
  let list = null;
  try {
    const raw = localStore?.getPreference?.(PREF_KEY);
    if (raw) list = JSON.parse(raw);
  } catch (e) {
    console.warn('[webSearch] 配置解析失败，按未配置处理:', e.message);
    list = null;
  }
  const providers = Array.isArray(list) ? list.filter((p) => p && PROVIDER_IDS.includes(p.id)) : [];
  // P0-20（2026-10-16）：发现历史明文 apiKey 且存在加密器时，自动在落盘层升级为 keyEncrypted
  let needsMigrate = false;
  let credentialFailure = false;
  const migratedIds = new Set();
  // 归一化：保证字段齐全，未知提供方剔除
  const normalized = SEARCH_PROVIDERS.map((meta) => {
    const saved = providers.find((p) => p.id === meta.id) || {};
    let apiKey = '';
    if (saved.keyEncrypted && credentialCrypto?.decrypt) {
      try { apiKey = String(credentialCrypto.decrypt(saved.keyEncrypted) || ''); }
      catch (e) {
        credentialFailure = true;
        console.error(`[webSearch] ${meta.id} 密钥解密失败；已禁用该项以防止覆盖密文:`, e.message);
      }
    } else if (saved.apiKey) {
      apiKey = String(saved.apiKey || '');
      if (credentialCrypto?.encrypt) {
        needsMigrate = true;
        migratedIds.add(meta.id);
      }
    }
    return {
      id: meta.id,
      enabled: saved.enabled === true && !(saved.keyEncrypted && !apiKey),
      apiKey,
      extra: saved.extra && typeof saved.extra === 'object' ? saved.extra : {},
    };
  });
  if (needsMigrate) {
    try { saveSearchConfig(localStore, normalized, credentialCrypto); }
    catch (e) {
      credentialFailure = true;
      for (const id of migratedIds) {
        const provider = normalized.find((entry) => entry.id === id);
        if (provider) provider.enabled = false;
      }
      console.error('[webSearch] 明文 Key 自动加密迁移失败；已禁用明文配置项:', e.message);
    }
  }
  if (credentialFailure) {
    for (const p of normalized) {
      const saved = providers.find((entry) => entry.id === p.id);
      if (saved?.keyEncrypted || (saved?.apiKey && credentialCrypto?.encrypt)) p.enabled = false;
    }
  }
  return { providers: normalized.map(({ _migrationFailed, ...provider }) => provider) };
}

function saveSearchConfig(localStore, providers, credentialCrypto = null) {
  const clean = (Array.isArray(providers) ? providers : [])
    .filter((p) => p && PROVIDER_IDS.includes(p.id))
    .map((p) => ({
      id: p.id,
      enabled: p.enabled === true,
      apiKey: String(p.apiKey || ''),
      extra: p.extra && typeof p.extra === 'object' ? p.extra : {},
    }));
  // P0-20：提供 credentialCrypto 时，落库 JSON 只存 keyEncrypted（apiKey 置空），
  // 保证 local-data.json 内搜索 Key 与 provider Key 具有同一安全级别。
  const persisted = clean.map((p) => {
    if (!p.apiKey) return p;
    if (!credentialCrypto?.encrypt) throw new Error(`[webSearch] ${p.id} 缺少凭证加密器，拒绝明文持久化`);
    // 配置包含密钥时必须 fail-closed，绝不在加密失败时明文落盘。
    const encrypted = credentialCrypto.encrypt(p.apiKey);
    if (typeof encrypted !== 'string' || !encrypted) throw new Error(`[webSearch] ${p.id} 密钥加密失败，拒绝明文持久化`);
    return { id: p.id, enabled: p.enabled, apiKey: '', keyEncrypted: encrypted, extra: p.extra };
  });
  localStore?.setPreference?.(PREF_KEY, JSON.stringify(persisted));
  return { providers: clean };
}

// ── 请求构造（纯函数）──
// 返回 { method, url, headers, body } ；缺 Key/缺参数时抛出带可行动提示的错误
function buildRequest(providerId, { query, limit, apiKey, extra } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query 为空');
  const cfg = { apiKey: String(apiKey || '').trim(), extra: extra || {} };

  switch (providerId) {
    case 'tavily': {
      if (!cfg.apiKey) throw new Error('缺少 TAVILY_API_KEY：请在 设置 → 网络配置 中填写（app.tavily.com 免费申请）');
      return {
        method: 'POST',
        url: 'https://api.tavily.com/search',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: cfg.apiKey, query: q, max_results: limit, search_depth: 'basic' }),
      };
    }
    case 'brave': {
      if (!cfg.apiKey) throw new Error('缺少 BRAVE_API_KEY：请在 设置 → 网络配置 中填写');
      return {
        method: 'GET',
        url: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${limit}`,
        headers: { 'X-Subscription-Token': cfg.apiKey, Accept: 'application/json' },
      };
    }
    case 'exa': {
      if (!cfg.apiKey) throw new Error('缺少 EXA_API_KEY：请在 设置 → 网络配置 中填写');
      return {
        method: 'POST',
        url: 'https://api.exa.ai/search',
        headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey },
        body: JSON.stringify({ query: q, numResults: limit }),
      };
    }
    case 'bing': {
      if (!cfg.apiKey) throw new Error('缺少 Bing 订阅密钥：请在 设置 → 网络配置 中填写');
      return {
        method: 'GET',
        url: `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(q)}&count=${limit}&responseFilter=webPages`,
        headers: { 'Ocp-Apim-Subscription-Key': cfg.apiKey },
      };
    }
    case 'google': {
      if (!cfg.apiKey) throw new Error('缺少 GOOGLE_API_KEY：请在 设置 → 网络配置 中填写');
      const cx = String(cfg.extra.engineId || '').trim();
      if (!cx) throw new Error('缺少搜索引擎 ID（cx）：请在 设置 → 网络配置 的 Google CSE 高级项中填写');
      return {
        method: 'GET',
        url: `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(cfg.apiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(q)}&num=${limit}`,
        headers: {},
      };
    }
    case 'searxng': {
      const base = String(cfg.extra.endpoint || '').trim().replace(/\/+$/, '');
      if (!base) throw new Error('缺少 SearXNG 实例地址：请在 设置 → 网络配置 的高级项中填写（例：https://searx.example.org）');
      return {
        method: 'GET',
        url: `${base}/search?q=${encodeURIComponent(q)}&format=json&language=zh-CN`,
        headers: {},
      };
    }
    case 'duckduckgo':
      return {
        method: 'GET',
        url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=cn-zh`,
        headers: {},
      };
    case 'baidu':
      return {
        method: 'GET',
        url: `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=${limit}`,
        headers: {},
      };
    default:
      throw new Error(`未知搜索提供方：${providerId}`);
  }
}

// ── 响应解析（纯函数）──
// 统一输出 [{ title, url, snippet }]；解析失败抛错（由 failover 落到下一家）
function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtmlTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '');
}

function parseResponse(providerId, bodyText) {
  const raw = String(bodyText || '');
  let items = null;

  if (providerId === 'tavily' || providerId === 'exa') {
    const j = JSON.parse(raw);
    items = (j.results || []).map((r) => ({
      title: String(r.title || '').slice(0, 200),
      url: String(r.url || '').slice(0, 500),
      snippet: String(r.content || r.text || r.snippet || '').slice(0, 600),
    }));
  } else if (providerId === 'brave') {
    const j = JSON.parse(raw);
    const web = j.web?.results || [];
    items = web.map((r) => ({
      title: String(r.title || '').slice(0, 200),
      url: String(r.url || '').slice(0, 500),
      snippet: String(r.description || '').slice(0, 600),
    }));
  } else if (providerId === 'bing') {
    const j = JSON.parse(raw);
    const web = j.webPages?.value || [];
    items = web.map((r) => ({
      title: String(r.name || '').slice(0, 200),
      url: String(r.url || '').slice(0, 500),
      snippet: String(r.snippet || '').slice(0, 600),
    }));
  } else if (providerId === 'google') {
    const j = JSON.parse(raw);
    const web = j.items || [];
    items = web.map((r) => ({
      title: String(r.title || '').slice(0, 200),
      url: String(r.link || '').slice(0, 500),
      snippet: String(r.snippet || '').slice(0, 600),
    }));
  } else if (providerId === 'searxng') {
    const j = JSON.parse(raw);
    items = (j.results || []).map((r) => ({
      title: String(r.title || '').slice(0, 200),
      url: String(r.url || '').slice(0, 500),
      snippet: String(r.content || '').slice(0, 600),
    }));
  } else if (providerId === 'duckduckgo') {
    // HTML 解析：结果锚点 class="result__a"，摘要 class="result__snippet"
    items = [];
    const anchorRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    const links = [];
    let m;
    while ((m = anchorRe.exec(raw)) !== null) {
      links.push({ url: m[1], title: decodeEntities(m[2]) });
    }
    const snippets = [];
    while ((m = snippetRe.exec(raw)) !== null) snippets.push(decodeEntities(m[1]));
    links.forEach((l, i) => {
      // DuckDuckGo 的 href 可能是 //duckduckgo.com/l/?uddg=<encoded> 的跳转壳，解出真实地址
      let url = l.url;
      const uddg = /[?&]uddg=([^&]+)/.exec(url);
      if (uddg) {
        try { url = decodeURIComponent(uddg[1]); } catch { /* 保留原值 */ }
      }
      items.push({ title: l.title.slice(0, 200), url: url.slice(0, 500), snippet: (snippets[i] || '').slice(0, 600) });
    });
  } else if (providerId === 'baidu') {
    // 百度反爬：命中安全验证页时如实告知（否则用户只看到「解析失败」，无从判断）
    if (/百度安全验证|wappass/.test(raw)) {
      throw new Error('百度返回了安全验证页（反爬拦截），本次请求未获得结果。'
        + '建议改用其他已启用的提供方（Tavily/Brave 等），或启用多家做容错。');
    }
    // HTML 解析：标题在 <h3[^>]*><a href="...">…</a>，摘要取该结果块内首个 c-abstract / content-right
    items = [];
    const blockRe = /<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = blockRe.exec(raw)) !== null) {
      const title = decodeEntities(m[2]);
      if (!title) continue;
      // 摘要：粗略取该锚点之后 1200 字符内的可读文本
      const after = raw.slice(m.index + m[0].length, m.index + m[0].length + 1200);
      const snippet = stripHtmlTags(after).replace(/\s+/g, ' ').trim().slice(0, 300);
      items.push({ title: title.slice(0, 200), url: m[1].slice(0, 500), snippet });
    }
  }

  if (!Array.isArray(items)) throw new Error('搜索服务返回结构无法识别');
  const cleaned = items.filter((r) => r && r.url && r.title);
  if (cleaned.length === 0) throw new Error('搜索服务未返回任何可用结果（可能是反爬拦截或参数问题）');
  return cleaned;
}

// ── 多提供方按序 failover ──
async function searchWithProviders(config, { query, limit = 5, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const enabled = (config?.providers || []).filter((p) => p.enabled === true);
  if (enabled.length === 0) {
    return {
      ok: false,
      error: 'web_search_unconfigured',
      hint: '当前未启用任何搜索提供方。请在 设置 → 网络配置 中开启（DuckDuckGo 无需 Key，开箱可用），'
        + '或改用 web_fetch 直接抓取已知 URL。',
      query,
    };
  }
  const attempts = [];
  for (const p of enabled) {
    const started = Date.now();
    try {
      const req = buildRequest(p.id, { query, limit, apiKey: p.apiKey, extra: p.extra });
      const res = await httpRequest(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        timeoutMs,
        maxBytes: 1024 * 1024,
      });
      const results = parseResponse(p.id, res.body).slice(0, limit);
      return {
        ok: true,
        query,
        provider: p.id,
        count: results.length,
        latencyMs: Date.now() - started,
        results,
      };
    } catch (e) {
      attempts.push({ provider: p.id, error: String(e?.message || e).slice(0, 200), latencyMs: Date.now() - started });
    }
  }
  return {
    ok: false,
    error: 'search_all_providers_failed',
    hint: `已启用的 ${enabled.length} 个搜索提供方全部失败（明细见 attempts）。可检查密钥有效性，或改用 web_fetch 直接抓取已知 URL。`,
    attempts,
    query,
  };
}

module.exports = {
  SEARCH_PROVIDERS, PROVIDER_IDS, PREF_KEY,
  loadSearchConfig, saveSearchConfig,
  buildRequest, parseResponse, searchWithProviders,
  decodeEntities, stripHtmlTags,
};

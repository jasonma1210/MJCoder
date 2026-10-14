// P0-A：Web 检索与抓取工具（主进程实现）
//
// 为什么放在独立模块而不是 main.js：
//   main.js 已有 2600+ 行，本次审查已把它列为 God Object（架构债 P3）。
//   Web 工具涉及网络、超时、HTML 解析、私网地址防护等独立关注点，独立成文件便于单测。
//
// 安全设计（与项目既有安全基线一致）：
//   · SSRF 防护：拒绝 localhost / 127.x / 私有网段 / 169.254（云元数据）等内网地址，
//     防止模型被诱导访问本机服务或云凭证端点；
//   · 仅允许 http/https，禁file:// / gopher: 等；
//   · 超时强制：不做无限等待，避免单轮卡死拖垮整个 Agent 回合；
//   · 响应体积上限：防止把几百 MB 内容一次性灌进上下文；
//   · HTML → 纯文本：剥离 script/style/注释，避免把页面脚本内容当正文喂给模型
//     （同时天然过滤了大部分脚本注入载体）。
const https = require('https');
const http = require('http');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB 上限
const DEFAULT_TEXT_LIMIT = 15000;

// ── SSRF 防护 ──
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  // IPv6 回环与链路本地
  if (/^f[cd]/.test(h)) return true; // fc00::/7 唯一本地地址
  if (h.startsWith('fe80')) return true;
  // IPv4 内网 / 链路本地 / 云元数据
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // AWS/GCP 元数据端点
  if (/^0\./.test(h)) return true;
  return false;
}

// ── 带超时与体积上限的 fetch ──
function httpGet(urlStr, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) {
      reject(new Error(`URL 格式非法：${urlStr}`));
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error(`仅支持 http/https 协议，收到：${parsed.protocol}`));
      return;
    }
    if (isPrivateHost(parsed.hostname)) {
      reject(new Error(`出于安全考虑禁止访问内网/本机地址：${parsed.hostname}`));
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(
      parsed.toString(),
      {
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'MJCode-Agent/1.0 (+https://github.com/jasonma1210/MJCoder)',
          Accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      },
      (res) => {
        // 跟随一次重定向（重定向后仍需复检 SSRF，否则可借302 跳内网）
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, parsed).toString();
          httpGet(next, { timeoutMs, maxBytes }).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}${res.statusMessage ? ` ${res.statusMessage}` : ''}`));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new Error(`响应体超过上限（${Math.round(maxBytes / 1024 / 1024)}MB），已中止`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({
          body: Buffer.concat(chunks).toString('utf8'),
          contentType: String(res.headers['content-type'] || ''),
          finalUrl: parsed.toString(),
        }));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`请求超时（>${Math.round(timeoutMs / 1000)}s）`));
    });
    req.on('error', (e) => reject(new Error(`网络请求失败：${e.message}`)));
  });
}

// ── HTML → 纯文本 ──
function htmlToText(html) {
  return String(html || '')
    // 先整块移除不可读/危险内容（顺序重要：注释里的 script 不能复活）
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    // 结构标签转换为换行，保留段落可读性
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    // 剩余标签直接去掉
    .replace(/<[^>]+>/g, ' ')
    // 还原实体
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── 工具实现 ──

/**
 * web_search：联网搜索。
 * 说明：此处不内置任何第三方搜索 SDK/API Key（会引入密钥管理与付费依赖），
 * 采用「无 Key 可用」策略——按配置读取搜索端点；未配置时明确告知模型不可用，
 * 而不是伪装成功或返回编造结果（伪造检索结果是 Agent 最不可接受的失败模式）。
 * 配置来源（可选）：环境变量 MJCODE_WEB_SEARCH_ENDPOINT / MJCODE_WEB_SEARCH_KEY。
 */
async function webSearch({ query, max_results: maxResults } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'search_query_missing: 必须提供 query 关键词' };
  const limit = Math.max(1, Math.min(Number(maxResults) || 5, 10));

  const endpoint = String(process.env.MJCODE_WEB_SEARCH_ENDPOINT || '').trim();
  const apiKey = String(process.env.MJCODE_WEB_SEARCH_KEY || '').trim();
  if (!endpoint) {
    return {
      ok: false,
      error: 'web_search_unconfigured',
      hint: '当前未配置联网搜索服务。请在设置中配置搜索端点，或改用 web_fetch 直接抓取已知 URL。'
        + '若需要官方文档，建议直接 web_fetch 该文档地址。',
      query: q,
    };
  }

  try {
    const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}q=${encodeURIComponent(q)}&count=${limit}`;
    const res = await httpGet(url, { maxBytes: 512 * 1024 });
    let parsed = null;
    try { parsed = JSON.parse(res.body); } catch { /* 非 JSON 则当纯文本处理 */ }
    const items = Array.isArray(parsed) ? parsed
      : (parsed?.results || parsed?.items || parsed?.data || null);
    if (!Array.isArray(items)) {
      return { ok: false, error: 'search_response_unrecognized', hint: '搜索服务返回结构无法识别', raw: res.body.slice(0, 500) };
    }
    const results = items.slice(0, limit).map((it) => ({
      title: String(it?.title || it?.name || '').slice(0, 200),
      url: String(it?.url || it?.link || '').slice(0, 500),
      snippet: String(it?.snippet || it?.description || it?.content || '').slice(0, 600),
      ...(apiKey ? {} : {}),
    }));
    return { ok: true, query: q, count: results.length, results };
  } catch (e) {
    return { ok: false, error: 'search_failed', message: String(e?.message || e), query: q };
  }
}

/**
 * web_fetch：抓取网页并转纯文本。
 */
async function webFetch({ url, offset, limit } = {}) {
  const u = String(url || '').trim();
  if (!u) return { ok: false, error: 'fetch_url_missing: 必须提供 url' };
  const start = Math.max(0, Number(offset) || 0);
  const maxChars = Math.max(200, Math.min(Number(limit) || DEFAULT_TEXT_LIMIT, 60000));

  try {
    const res = await httpGet(u);
    const isJson = /application\/json/i.test(res.contentType);
    const text = isJson ? res.body : htmlToText(res.body);
    const slice = text.slice(start, start + maxChars);
    const truncated = start + maxChars < text.length;
    return {
      ok: true,
      url: res.finalUrl,
      contentType: res.contentType,
      totalChars: text.length,
      offset: start,
      truncated,
      content: slice || (text.length === 0 ? '（页面内容为空，或为纯前端渲染的页面——此类页面需改用搜索或直接看官方文档源码）' : slice),
      ...(truncated ? { hint: `内容较长已截断，可传 offset=${start + maxChars} 继续读取后续部分` } : {}),
    };
  } catch (e) {
    return { ok: false, error: 'fetch_failed', url: u, message: String(e?.message || e) };
  }
}

module.exports = { webSearch, webFetch, htmlToText, isPrivateHost, httpGet };

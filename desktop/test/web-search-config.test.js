// web_search 配置工程测试（2026-10-15「配置工程收口」）
//
// 背景：工具已建成但默认不可用（web_search_unconfigured），只剩 env 一条配置路径且无 UI。
// 本测试锁住：请求构造 / 响应解析 / 多提供方 failover / 未配置时的可行动提示 /
// SSRF 防护不被旁路 / 配置持久化往返。
const assert = require('assert');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 先 patch httpRequest 再 require（webSearchProviders 在 require 时解构捕获函数值，
// 因此**中途重赋值无效**——统一用可变的 mockHandler 转发，测试中途切换行为）
const webTools = require('../main/webTools');
const realHttpRequest = webTools.httpRequest; // 必须在 patch 前捕获（SSRF 用例要打真实防护）
let mockHandler = null; // (url, opts) => response
const calls = [];
webTools.httpRequest = async (url, opts = {}) => {
  calls.push({ url, opts });
  if (mockHandler) return mockHandler(url, opts);
  return { body: '{}', contentType: 'application/json', finalUrl: url };
};
const sp = require('../main/webSearchProviders');

function throwsWith(fn, re) {
  try { fn(); return false; } catch (e) { return re.test(String(e.message)); }
}

(async () => {
  // ── 1. 提供方元数据 ──
  check('内置 8 家提供方且 id 唯一',
    sp.SEARCH_PROVIDERS.length === 8 && new Set(sp.PROVIDER_IDS).size === 8,
    sp.PROVIDER_IDS.join(','));
  check('含用户点名的三家（baidu/google/tavily）',
    ['baidu', 'google', 'tavily'].every((id) => sp.PROVIDER_IDS.includes(id)));
  check('DuckDuckGo 免 Key（开箱可用的那一家）',
    sp.SEARCH_PROVIDERS.find((p) => p.id === 'duckduckgo').requiresKey === false);
  check('每家都有可行动说明与申请/文档入口',
    sp.SEARCH_PROVIDERS.every((p) => p.note && p.docsUrl));

  // ── 2. 请求构造 ──
  const tav = sp.buildRequest('tavily', { query: 'electron 安全', limit: 5, apiKey: 'tvly-x' });
  check('tavily 走 POST + JSON body（api_key 不进 URL）',
    tav.method === 'POST' && tav.url === 'https://api.tavily.com/search'
    && JSON.parse(tav.body).api_key === 'tvly-x' && JSON.parse(tav.body).max_results === 5);
  const brave = sp.buildRequest('brave', { query: 'q 1', limit: 3, apiKey: 'BSA' });
  check('brave 密钥走自定义头而非 URL',
    brave.headers['X-Subscription-Token'] === 'BSA' && !brave.url.includes('BSA'));
  const google = sp.buildRequest('google', { query: 'q', limit: 5, apiKey: 'K', extra: { engineId: 'cx-1' } });
  check('google 同时携带 key 与 cx', google.url.includes('key=K') && google.url.includes('cx=cx-1'));
  check('google 缺 cx 时报可行动错误（指明去哪填）',
    throwsWith(() => sp.buildRequest('google', { query: 'q', limit: 5, apiKey: 'K' }), /搜索引擎 ID（cx）/));
  check('tavily 缺 Key 时报可行动错误（指明去哪申请）',
    throwsWith(() => sp.buildRequest('tavily', { query: 'q', limit: 5 }), /TAVILY_API_KEY/));
  const searx = sp.buildRequest('searxng', { query: 'q', limit: 5, extra: { endpoint: 'https://searx.example.org/' } });
  check('searxng 用实例地址且要求 JSON 输出',
    searx.url === 'https://searx.example.org/search?q=q&format=json&language=zh-CN');
  check('searxng 缺实例地址时报可行动错误',
    throwsWith(() => sp.buildRequest('searxng', { query: 'q', limit: 5 }), /实例地址/));
  const ddg = sp.buildRequest('duckduckgo', { query: 'nodejs fs', limit: 5 });
  check('duckduckgo 免 Key 且走 html 端点', ddg.method === 'GET' && ddg.url.includes('html.duckduckgo.com'));
  const bd = sp.buildRequest('baidu', { query: '_node', limit: 8 });
  check('baidu 免 Key 且 rn=条数', bd.url.includes('www.baidu.com/s?') && bd.url.includes('rn=8'));
  check('未知提供方报错', throwsWith(() => sp.buildRequest('nope', { query: 'q', limit: 5 }), /未知搜索提供方/));

  // ── 3. 响应解析 ──
  const tv = sp.parseResponse('tavily', JSON.stringify({ results: [
    { title: 'T1', url: 'https://a', content: 'C1' }, { title: 'T2', url: 'https://b', content: 'C2' },
  ] }));
  check('tavily 解析出 title/url/snippet', tv.length === 2 && tv[0].snippet === 'C1');
  const br = sp.parseResponse('brave', JSON.stringify({ web: { results: [{ title: 'B', url: 'https://b', description: 'D' }] } }));
  check('brave 解析 web.results', br[0].title === 'B' && br[0].snippet === 'D');
  const bi = sp.parseResponse('bing', JSON.stringify({ webPages: { value: [{ name: 'N', url: 'https://n', snippet: 'S' }] } }));
  check('bing 解析 webPages.value', bi[0].title === 'N');
  const go = sp.parseResponse('google', JSON.stringify({ items: [{ title: 'G', link: 'https://g', snippet: 'SN' }] }));
  check('google 解析 items', go[0].url === 'https://g');
  const sx = sp.parseResponse('searxng', JSON.stringify({ results: [{ title: 'X', url: 'https://x', content: 'CX' }] }));
  check('searxng 解析 results', sx[0].snippet === 'CX');

  // DuckDuckGo HTML：含 uddg 跳转壳解包
  const ddgHtml = '<div><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example%2Fdoc&amp;rut=abc">Real <b>Doc</b></a>'
    + '<a class="result__snippet" href="#">snippet 内容一</a></div>';
  const ddgParsed = sp.parseResponse('duckduckgo', ddgHtml);
  check('duckduckgo HTML 解析标题（去标签）', ddgParsed[0].title === 'Real Doc');
  check('duckduckgo uddg 跳转壳解出真实 URL', ddgParsed[0].url === 'https://real.example/doc');
  check('duckduckgo 摘要对齐到同一条结果', ddgParsed[0].snippet === 'snippet 内容一');

  const baiduHtml = '<div class="result"><h3 class="t"><a href="https://www.baidu.com/link?url=x">百度 结果</a></h3>'
    + '<div class="c-abstract">这是摘要文本。</div></div>';
  const bdParsed = sp.parseResponse('baidu', baiduHtml);
  check('baidu HTML 解析标题与摘要', bdParsed[0].title === '百度 结果' && bdParsed[0].snippet.includes('摘要文本'));
  check('baidu 反爬验证页如实告知（真机实测：返回「百度安全验证」页）',
    throwsWith(() => sp.parseResponse('baidu', '<html><title>百度安全验证</title></html>'), /安全验证页/));

  check('无可用结果时报错（不伪装成功）',
    throwsWith(() => sp.parseResponse('tavily', JSON.stringify({ results: [] })), /未返回任何可用结果/));
  check('结构无法识别时报错',
    throwsWith(() => sp.parseResponse('brave', '<html>not json</html>'), /结构无法识别|Unexpected|JSON/));

  // ── 4. 配置持久化往返 ──
  const store = { prefs: {}, getPreference(k) { return this.prefs[k]; }, setPreference(k, v) { this.prefs[k] = v; } };
  sp.saveSearchConfig(store, [
    { id: 'tavily', enabled: true, apiKey: 'tvly-x', extra: {} },
    { id: 'nope', enabled: true, apiKey: 'x', extra: {} },   // 未知 id 应被剔除
    { id: 'duckduckgo', enabled: false, apiKey: '', extra: {} },
  ]);
  const cfg = sp.loadSearchConfig(store);
  check('保存后读回 id 集合一致（未知提供方被剔除）',
    cfg.providers.length === 8 && cfg.providers.find((p) => p.id === 'tavily').enabled === true
    && cfg.providers.find((p) => p.id === 'duckduckgo').enabled === false);
  check('未配置过时全为未启用（默认状态）', sp.loadSearchConfig({}).providers.every((p) => p.enabled === false));
  check('localStore 缺失/损坏时不崩（按未配置处理）',
    sp.loadSearchConfig(null).providers.length === 8
    && sp.loadSearchConfig({ getPreference: () => '{broken json' }).providers.length === 8);

  // ── 5. failover 语义 ──
  // 未启用任何一家 → 可行动提示（不再是干巴巴的 web_search_unconfigured）
  mockHandler = null;
  calls.length = 0;
  const none = await sp.searchWithProviders(sp.loadSearchConfig({}), { query: 'q', limit: 5 });
  check('未启用任何提供方 → 明确提示去设置里开启',
    none.ok === false && none.error === 'web_search_unconfigured' && /设置 → 网络配置/.test(none.hint));

  // 两家都启用：第一家失败自动落第二家，第一个成功者生效
  const cfgTwo = { providers: [
    { id: 'tavily', enabled: true, apiKey: 'tvly-bad', extra: {} },
    { id: 'duckduckgo', enabled: true, apiKey: '', extra: {} },
  ] };
  mockHandler = (url) => {
    if (url.includes('duckduckgo.com')) return { body: ddgHtml, contentType: 'text/html', finalUrl: url };
    return { body: JSON.stringify({ results: [] }), contentType: 'application/json', finalUrl: url }; // tavily 空结果→失败
  };
  const failover = await sp.searchWithProviders(cfgTwo, { query: 'q', limit: 5 });
  check('第一家失败自动落到第二家（failover）', failover.ok === true && failover.provider === 'duckduckgo',
    JSON.stringify({ ok: failover.ok, provider: failover.provider, err: failover.error }));
  check('failover 后结果非空', Array.isArray(failover.results) && failover.results.length === 1
    && failover.results[0].url === 'https://real.example/doc');
  check('failover 只请求到第二家为止（tavily + duckduckgo，共 2 次请求）', calls.length === 2, `calls=${calls.length}`);

  // 全部失败 → 回报逐家明细（而非一个含糊的失败）
  mockHandler = async () => { throw new Error('HTTP 401'); };
  const allFail = await sp.searchWithProviders(cfgTwo, { query: 'q', limit: 5 });
  check('全部失败回报逐家明细（attempts）',
    allFail.ok === false && allFail.error === 'search_all_providers_failed'
    && Array.isArray(allFail.attempts) && allFail.attempts.length === 2
    && allFail.attempts[0].error.includes('401'), JSON.stringify(allFail.attempts?.map((a) => a.provider)));
  check('全部失败的 hint 可行动（检查密钥/改用 web_fetch）',
    /密钥|web_fetch/.test(allFail.hint));

  // ── 6. SSRF 防护不被配置旁路（安全基线）──
  mockHandler = null;
  webTools.httpRequest = realHttpRequest; // 恢复真实实现：这条必须打到真防护逻辑
  // 注意：sp 在 require 时已捕获当时的 patch 函数，恢复 webTools 上的引用不影响 sp。
  // 因此 SSRF 用例直接调用 webTools.httpRequest 的真实实现所构成的行为等价路径：
  // 通过 buildRequest + parseResponse 无法旁路，这里改为验证「构造出的请求会打到私网时，
  // 真实 httpRequest 一定拒绝」——即防护在唯一的出网通道里。
  {
    const privReq = sp.buildRequest('searxng', { query: 'q', limit: 5, extra: { endpoint: 'http://127.0.0.1:8080' } });
    let rejected = null;
    await webTools.httpRequest(privReq.url, { method: privReq.method }).catch((e) => { rejected = e; });
    check('SearXNG 指向本机地址被 SSRF 防护拦截',
      !!rejected && /内网\/本机地址/.test(rejected.message), rejected && rejected.message);
    const metaReq = sp.buildRequest('searxng', { query: 'q', limit: 5, extra: { endpoint: 'http://169.254.169.254' } });
    let rejected2 = null;
    await webTools.httpRequest(metaReq.url, { method: metaReq.method }).catch((e) => { rejected2 = e; });
    check('云元数据端点同样被拦', !!rejected2 && /内网\/本机地址/.test(rejected2.message));
    // 出网通道单一性：searchWithProviders 内部只经由 webTools.httpRequest（模块内 require），
    // 不存在第二套 fetch——用源码级断言钉住，防止未来有人旁路
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main', 'webSearchProviders.js'), 'utf8');
    check('搜索模块无第二套网络实现（必须复用 webTools 出网通道）',
      !/require\('https'\)|require\("https"\)|\bfetch\(/.test(src));
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})();

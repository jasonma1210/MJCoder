// 网络插件发现（对话内安装的上游）：从公共源自动搜索可安装的 MCP Server / 技能仓库
// 设计要点：
//   1) 不依赖自建市场索引（MJ_MARKET_INDEX_URL 未配置时也有结果）——公共源：
//      npm registry（MCP Server 生态的发布主阵地）+ GitHub 仓库搜索（技能/工具仓库）；
//   2) fetch 实现可注入（单测离线跑）；单源失败 fail-open（另一源结果照常返回）；
//   3) 输出统一归一为纯数据：{ source, type, name, version?, description, url, install? }，
//      install 字段即「怎么装」的声明，installNetwork IPC 据此路由。
const NPM_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';
// npm 官方源在国内网络常不可达（真机实测连接超时）：按序回落淘宝镜像，
// npmmirror 完整支持 registry v1 search API。GitHub API 无镜像需求（实测可达）。
const NPM_SEARCH_HOSTS = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'];
const GITHUB_SEARCH_URL = 'https://api.github.com/search/repositories';
const DEFAULT_TIMEOUT_MS = 10000;

// npm 包名合法性（scoped 与普通）：安装时校验，杜绝把任意字符串塞进 npx
function isValidNpmPkg(name) {
  const n = String(name == null ? '' : name).trim();
  if (n.length === 0 || n.length > 214) return false;
  if (n.startsWith('.') || n.startsWith('_') || n.includes('..')) return false;
  // 禁 shell 元字符（npx -y <pkg> 虽走 execFile 数组，仍从源头收紧）
  if (/[^\w@/.-]/.test(n)) return false;
  const scoped = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
  return scoped.test(n);
}

// GitHub 仓库名 → 合法插件/技能名（复用插件名规则语义：小写字母数字与 . _ -）
function repoToSkillName(fullName) {
  const base = String(fullName || '').split('/').pop() || '';
  const cleaned = base.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.slice(0, 63);
}

async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, fetchImpl } = {}) {
  const impl = fetchImpl || globalThis.fetch;
  if (typeof impl !== 'function') throw new Error('当前环境无 fetch');
  const res = await impl(url, {
    headers: { 'user-agent': 'MJ-Coder-PluginDiscovery/1.0', accept: 'application/vnd.github+json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}（${url.slice(0, 80)}）`);
  return res.json();
}

// npm registry 搜索 MCP Server。text 追加 "mcp server" 提升相关度；
// 安装声明 = npx -y <pkg>（运行时自动拉取，无需本地落盘）。
// 多 host 依次回落（npm 官方 → npmmirror 镜像），全部失败才抛错。
async function searchNpmMcp(query, { limit = 8, timeoutMs, fetchImpl } = {}) {
  const q = encodeURIComponent(`${String(query || '').trim()} mcp server`.trim());
  const size = Math.min(20, Math.max(1, limit));
  let lastErr = null;
  for (const host of NPM_SEARCH_HOSTS) {
    try {
      const data = await fetchJson(`${host}/-/v1/search?text=${q}&size=${size}`, { timeoutMs, fetchImpl });
      const objects = Array.isArray(data?.objects) ? data.objects : [];
      return objects.map((o) => {
        const p = o.package || {};
        const repo = p.links?.repository || p.links?.npm || `https://www.npmjs.com/package/${p.name}`;
        return {
          source: 'npm',
          type: 'mcp',
          name: p.name,
          version: p.version,
          description: String(p.description || '').slice(0, 200),
          url: repo,
          publisher: p.publisher?.username || (String(p.name || '').startsWith('@') ? String(p.name).split('/')[0].replace(/^@/, '') : 'npm'),
          score: o.score?.searchScore || 0,
          install: { command: 'npx', args: ['-y', p.name] },
        };
      }).filter((r) => isValidNpmPkg(r.name));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('npm 源全部不可达');
}

// GitHub 仓库搜索（技能仓库 / MCP 相关仓库）。q 由模型给定的关键词直传，按 star 排序
async function searchGithubSkills(query, { limit = 8, timeoutMs, fetchImpl } = {}) {
  const q = encodeURIComponent(`${String(query || '').trim()}`.slice(0, 200));
  const data = await fetchJson(`${GITHUB_SEARCH_URL}?q=${q}&sort=stars&order=desc&per_page=${Math.min(20, Math.max(1, limit))}`, { timeoutMs, fetchImpl });
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.map((it) => ({
    source: 'github',
    type: 'skill',
    name: repoToSkillName(it.full_name),
    version: null,
    description: String(it.description || '').slice(0, 200),
    url: it.html_url,
    publisher: String(it.full_name || '').split('/')[0] || '',
    stars: it.stargazers_count || 0,
    install: { gitUrl: it.clone_url || `https://github.com/${it.full_name}.git`, ref: it.default_branch || '' },
  })).filter((r) => r.name);
}

// 多源合并：按 source:name 去重，保序（先到先得），cap 总数
function mergePluginResults(groups, cap = 16) {
  const seen = new Set();
  const out = [];
  for (const group of (groups || [])) {
    for (const r of (group || [])) {
      const key = `${r.source}:${r.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

// 网络搜索入口：npm + GitHub 并行，单源失败不影响另一源（fail-open，错误附在 notes）
async function searchNetworkPlugins(query, { types, timeoutMs, fetchImpl } = {}) {
  const want = new Set(Array.isArray(types) && types.length ? types : ['mcp', 'skill']);
  const jobs = [];
  const notes = [];
  if (want.has('mcp')) {
    jobs.push(
      searchNpmMcp(query, { timeoutMs, fetchImpl })
        .then((r) => ({ ok: true, src: 'npm', r }))
        .catch((e) => { notes.push(`npm 源失败：${e.message}`); return { ok: false, src: 'npm', r: [] }; }),
    );
  }
  if (want.has('skill')) {
    jobs.push(
      searchGithubSkills(query, { timeoutMs, fetchImpl })
        .then((r) => ({ ok: true, src: 'github', r }))
        .catch((e) => { notes.push(`GitHub 源失败：${e.message}`); return { ok: false, src: 'github', r: [] }; }),
    );
  }
  const settled = await Promise.all(jobs);
  const results = mergePluginResults(settled.filter((s) => s.ok).map((s) => s.r));
  return { ok: results.length > 0 || notes.length === 0, results, notes };
}

module.exports = {
  NPM_SEARCH_URL,
  NPM_SEARCH_HOSTS,
  GITHUB_SEARCH_URL,
  isValidNpmPkg,
  repoToSkillName,
  searchNpmMcp,
  searchGithubSkills,
  mergePluginResults,
  searchNetworkPlugins,
};

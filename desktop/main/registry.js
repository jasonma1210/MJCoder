// 插件注册中心（M6 / P3）
// 分发三步走的第二步：一个静态 JSON 索引 + tarball 地址，零服务端基建。
// 索引可从本地文件或远端 URL 热更新；拉取失败时回落缓存（fail-safe，不阻断既有浏览能力）。
// 索引条目本身不携带可执行代码，安装仍走 pluginMarket 的签名与权限双闸。
const fs = require('fs');
const path = require('path');
const { normalizeName, parsePermissions, summarizePermissions, PLUGIN_TYPES } = require('./pluginMarket');

// 索引文件原子写入（缓存落盘）
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// 解析索引 JSON（字符串 / 对象）
function parseIndex(input) {
  let raw = input;
  if (Buffer.isBuffer(raw)) raw = String(raw);
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      return { ok: false, plugins: [], error: `索引不是合法 JSON：${e.message}` };
    }
  }
  if (Array.isArray(raw)) raw = { plugins: raw };
  if (!raw || typeof raw !== 'object') return { ok: false, plugins: [], error: '索引必须是对象或数组' };
  const list = Array.isArray(raw.plugins) ? raw.plugins : [];
  return { ok: true, plugins: list.map(normalizeEntry).filter(Boolean), error: null, updatedAt: Number(raw.updatedAt || 0) };
}

// 规范化索引条目（缺 name 的条目直接丢弃）
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const name = normalizeName(entry.name);
  if (!name) return null;
  return {
    name,
    version: String(entry.version || '0.0.0'),
    type: PLUGIN_TYPES.includes(entry.type) ? entry.type : 'prompt',
    description: String(entry.description || '').slice(0, 500),
    author: String(entry.author || '').slice(0, 200),
    homepage: String(entry.homepage || '').slice(0, 500),
    tags: Array.isArray(entry.tags) ? entry.tags.map((t) => String(t).slice(0, 40)).slice(0, 20) : [],
    // 安装来源：git 仓库地址或 tarball 地址
    source: String(entry.source || entry.git || entry.tarball || ''),
    sourceType: entry.tarball ? 'tarball' : (entry.git ? 'git' : 'git'),
    permissions: Array.isArray(entry.permissions) ? entry.permissions : [],
    signature: String(entry.signature || ''),
    downloads: Number(entry.downloads || 0),
    updatedAt: Number(entry.updatedAt || 0),
    verified: !!entry.signature,
  };
}

// 从 tarball 地址推断对应的 git 仓库地址（tarball 与 git 同源时）
function gitUrlFromTarball(tarball) {
  const m = String(tarball || '').match(/^(https?:\/\/[^\s/]+)\/(.+?)\/-\/[^/]+\.tgz$/);
  return m ? `${m[1]}/${m[2]}.git` : '';
}

// 搜索与过滤：q 命中名称/描述/标签，type 过滤形态，tag 过滤标签，sort 支持 downloads/newest/name
function searchPlugins(plugins, options = {}) {
  const { q = '', type = '', tag = '', sort = 'downloads' } = options || {};
  const keyword = String(q).trim().toLowerCase();

  let list = plugins.filter((p) => {
    if (type && p.type !== type) return false;
    if (tag && !p.tags.includes(tag)) return false;
    if (!keyword) return true;
    return p.name.toLowerCase().includes(keyword)
      || p.description.toLowerCase().includes(keyword)
      || p.author.toLowerCase().includes(keyword)
      || p.tags.some((t) => String(t).toLowerCase().includes(keyword));
  });

  const sorted = [...list];
  if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === 'newest') sorted.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || b.downloads - a.downloads);
  else sorted.sort((a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name));

  list = sorted;
  return {
    total: list.length,
    plugins: list.slice(0, Math.max(1, Math.min(Number(options.limit) || 200, 500))),
  };
}

class Registry {
  constructor(options = {}) {
    this.cacheFile = options.cacheFile || '';
    this.remoteUrl = options.remoteUrl || '';
    this.timeout = Number(options.timeout || 8000);
    this.plugins = [];
    this.updatedAt = 0;
    this.loadCache();
  }

  // 读取本地缓存索引
  loadCache() {
    if (!this.cacheFile || !fs.existsSync(this.cacheFile)) return false;
    try {
      const parsed = parseIndex(fs.readFileSync(this.cacheFile, 'utf8'));
      if (parsed.ok) {
        this.plugins = parsed.plugins;
        this.updatedAt = parsed.updatedAt || 0;
        return true;
      }
      return false;
    } catch (e) {
      console.warn('[registry] 缓存索引读取失败:', e.message);
      return false;
    }
  }

  saveCache() {
    if (!this.cacheFile) return;
    try {
      writeJsonAtomic(this.cacheFile, { updatedAt: this.updatedAt, plugins: this.plugins });
    } catch (e) {
      console.warn('[registry] 缓存索引写入失败:', e.message);
    }
  }

  // 从本地文件加载索引（自建/私有源）
  loadFile(file) {
    const parsed = parseIndex(fs.readFileSync(file, 'utf8'));
    if (!parsed.ok) throw new Error(parsed.error);
    this.plugins = parsed.plugins;
    this.updatedAt = parsed.updatedAt || Date.now();
    this.saveCache();
    return this.list();
  }

  // 从远端 URL 热更新（仅 http/https）；失败时保留缓存内容
  async fetchRemote() {
    if (!this.remoteUrl) return { ok: false, error: '未配置远端索引地址' };
    let u;
    try {
      u = new URL(this.remoteUrl);
    } catch {
      return { ok: false, error: '远端索引地址非法' };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, error: `远端索引协议不支持：${u.protocol}（仅允许 http/https）` };
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    try {
      const res = await fetch(this.remoteUrl, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) return { ok: false, error: `远端索引返回状态 ${res.status}` };
      const parsed = parseIndex(await res.text());
      if (!parsed.ok) return { ok: false, error: parsed.error };
      this.plugins = parsed.plugins;
      this.updatedAt = parsed.updatedAt || Date.now();
      this.saveCache();
      return { ok: true, total: this.plugins.length };
    } catch (e) {
      // 拉取失败不抛错：回落缓存，保持既有浏览能力（市场索引非安全边界）
      return { ok: false, error: `远端索引拉取失败，已使用本地缓存：${e.message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  // 组合入口：有远端则热更新，否则读缓存
  async refresh() {
    if (this.remoteUrl) return this.fetchRemote();
    return { ok: true, total: this.plugins.length, cached: true };
  }

  list() {
    return this.plugins.map((p) => ({ ...p, permissionSummary: summarizePermissions(p.permissions) }));
  }

  get(name) {
    const n = normalizeName(name);
    return this.plugins.find((p) => p.name === n) || null;
  }

  search(options) {
    const hit = searchPlugins(this.list(), options);
    return { ...hit, updatedAt: this.updatedAt };
  }

  // 本地发布（增）：同名覆盖
  publish(entry) {
    const norm = normalizeEntry(entry);
    if (!norm) throw new Error('索引条目缺少 name');
    if (!norm.source) throw new Error('索引条目缺少 source（git 地址或 tarball 地址）');
    if (norm.sourceType === 'tarball' && !norm.gitUrl) norm.gitUrl = gitUrlFromTarball(norm.source);
    const idx = this.plugins.findIndex((p) => p.name === norm.name);
    if (idx >= 0) this.plugins[idx] = norm;
    else this.plugins.push(norm);
    this.updatedAt = Date.now();
    this.saveCache();
    return norm;
  }

  unpublish(name) {
    const n = normalizeName(name);
    const before = this.plugins.length;
    this.plugins = this.plugins.filter((p) => p.name !== n);
    this.saveCache();
    return this.plugins.length !== before;
  }

  // 索引自检：非法条目在导入时被丢弃，此处复核权限声明
  validate() {
    const problems = [];
    for (const p of this.plugins) {
      const perms = parsePermissions(p.permissions);
      for (const e of perms.errors) problems.push(`${p.name}: ${e}`);
    }
    return { ok: problems.length === 0, problems };
  }
}

module.exports = {
  parseIndex,
  normalizeEntry,
  searchPlugins,
  gitUrlFromTarball,
  writeJsonAtomic,
  Registry,
};
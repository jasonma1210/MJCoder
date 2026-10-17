// 从 WorkBuddy 连接器目录导入 MCP 服务定义（2026-10-17）
//
// 背景：MJCode 自带目录只有 80 条，且不少条目的 URL 已不可用；而本机 WorkBuddy 的
// `~/.workbuddy/connectors-marketplace/connectors/` 有 270 个目录、229 个服务定义，
// 是「真实可用的地址 + 真实鉴权方式」。
//
// 本脚本**只读** WorkBuddy 目录（不写、不碰凭证），生成/合并到 MJCode 的
// `ecosystem/mcp-connectors.json`：
//   · 已存在的条目（按 url / pkg / name 匹配）一律保留 MJCode 的手写描述，不覆盖；
//   · 只追加 WorkBuddy 独有条目，id 前缀 `wb-`，可反复运行（幂等）。
//
// 用法：
//   node scripts/import-workbuddy-connectors.mjs            # 预览统计，不写文件
//   node scripts/import-workbuddy-connectors.mjs --write     # 实际合并写盘
//   node scripts/import-workbuddy-connectors.mjs --write --no-sse
//        （默认**导入** sse：客户端已实现 SSE 传输（GET 建流 + POST 投递）；
//         加 --no-sse 可只导 streamableHttp/stdio）
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
// 输出到**独立文件**：主目录有「条目数 ≤ 90」的收敛门禁（防止再膨胀成大量不可用条目，
// 由 test/connector-catalog.test.mjs 守护）。WorkBuddy 全量目录作为第二来源，由加载层合并。
const CURATED = path.join(ROOT, '..', 'ecosystem/mcp-connectors.json');
const TARGET = path.join(ROOT, '..', 'ecosystem/mcp-connectors-workbuddy.json');
const WB = path.join(os.homedir(), '.workbuddy/connectors-marketplace/connectors');
const WRITE = process.argv.includes('--write');
const INCLUDE_SSE = !process.argv.includes('--no-sse');

const PLACEHOLDER = /\$\{(\w+)\}/g;
const HTTP_TYPES = /^(streamableHttp|streamable-http|http)$/i;

/** header 模板里出现的变量名（去重） */
function placeholders(obj) {
  const out = new Set();
  for (const raw of Object.values(obj || {})) {
    for (const m of String(raw || '').matchAll(PLACEHOLDER)) out.add(m[1]);
  }
  return [...out];
}

/** npx/uvx/docker 命令 → MJCode 的 install 形状 */
function stdioInstall(cmd, args) {
  const argv = Array.isArray(args) ? args : [];
  if (cmd === 'npx' || cmd === 'npm') {
    // npx -y <pkg> [rest]
    const pkg = argv.find((a) => a && !a.startsWith('-')) || '';
    const rest = argv.slice(argv.indexOf(pkg) + 1);
    return { type: 'npm', pkg, args: rest };
  }
  if (cmd === 'uvx') {
    const pkg = argv.find((a) => a && !a.startsWith('-')) || '';
    return { type: 'uvx', pkg, args: argv.slice(argv.indexOf(pkg) + 1) };
  }
  if (cmd === 'docker') return { type: 'docker', args: argv };
  return { type: 'manual' };
}

// 供应链加固（2026-10-17）：WorkBuddy 的 stdio 条目普遍是 `npx -y <pkg>@latest`——
// 无版本锁定意味着「同一份目录，不同时间连的是不同代码」，且首次连接就会在用户机器上
// 下载并执行第三方包。这里在导入期把 `@latest` 解析成具体版本，做到可复现、可审计。
// 代价：不会自动跟随上游更新——需要更新时重跑本脚本（脚本是幂等的）。
const versionCache = new Map();
function pinVersion(spec) {
  const at = spec.lastIndexOf('@');
  const tail = at > 0 ? spec.slice(at + 1) : '';
  // 已经是具体版本（0.8.0 / ^1.2 / >=2）→ 原样保留
  if (at > 0 && /^[\d^~><=*]/.test(tail)) return spec;
  // 否则 `at` 后面是 dist-tag（latest / beta）或不存在：包名要切掉 tag，
  // 否则会拼成 `pkg@latest@1.2.3`（真机上出现过）
  const name = at > 0 ? spec.slice(0, at) : spec;
  if (versionCache.has(name)) return versionCache.get(name);
  try {
    const meta = JSON.parse(execFileSync('npm', ['view', name, 'dist-tags.latest', '--json'], { encoding: 'utf8', timeout: 15000 }).trim());
    const v = typeof meta === 'string' ? meta : (meta && meta.latest) || '';
    const out = v ? `${name}@${v}` : spec;
    versionCache.set(name, out);
    return out;
  } catch (e) {
    versionCache.set(name, spec); // 查不到就保留原样，不编造版本
    return spec;
  }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

const curated = readJson(CURATED);
if (!curated || !Array.isArray(curated.connectors)) {
  console.error(`无法读取主目录：${CURATED}`);
  process.exit(2);
}

// 现有条目的去重键：url / pkg / name
const seenUrls = new Set();
const seenPkgs = new Set();
const seenNames = new Set();
for (const c of curated.connectors) {
  const i = c.install || {};
  if (i.url) seenUrls.add(String(i.url).replace(/\/+$/, '').toLowerCase());
  if (i.pkg) seenPkgs.add(String(i.pkg).toLowerCase());
  if (c.name) seenNames.add(String(c.name).toLowerCase());
}

const added = [];
const skipped = { dup: 0, sse: 0, noServer: 0, badJson: 0, manual: 0 };
const sseList = [];

if (!fs.existsSync(WB)) {
  console.error(`WorkBuddy 连接器目录不存在：${WB}`);
  process.exit(2);
}

for (const dir of fs.readdirSync(WB).sort()) {
  const mcpPath = path.join(WB, dir, 'mcp.json');
  if (!fs.existsSync(mcpPath)) continue;
  const mcp = readJson(mcpPath);
  if (!mcp) { skipped.badJson++; continue; }
  const servers = mcp.mcpServers || {};
  if (!Object.keys(servers).length) { skipped.noServer++; continue; }

  // cli.json 提供「先授权」命令（preAuth: 'cli' 时必看）
  const cli = readJson(path.join(WB, dir, 'cli.json')) || {};
  const authCmd = cli.auth ? (cli.auth[process.platform] || cli.auth.darwin || '') : '';

  for (const [serverName, s] of Object.entries(servers)) {
    const type = String(s.type || '').trim();
    const isHttp = HTTP_TYPES.test(type);
    const isSse = /^sse$/i.test(type);
    if (isSse) {
      sseList.push(dir);
      if (!INCLUDE_SSE) { skipped.sse++; continue; }
    }
    if (!isHttp && !isSse && !s.command) continue;

    const url = isHttp || isSse ? String(s.url || '').trim() : '';
    if ((isHttp || isSse) && !url) continue;

    const key = url ? url.replace(/\/+$/, '').toLowerCase() : '';
    const install = isHttp || isSse
      ? { type: 'remote', url, ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}) }
      : stdioInstall(s.command, s.args);
    if (install.type === 'npm' && install.pkg) install.pkg = pinVersion(install.pkg);

    if (key && seenUrls.has(key)) { skipped.dup++; continue; }
    if (install.pkg && seenPkgs.has(String(install.pkg).toLowerCase())) { skipped.dup++; continue; }
    if (seenNames.has(serverName.toLowerCase())) { skipped.dup++; continue; }

    // key 可能在 headers，也可能在 url 的 query（`?token=${TUSHARE_TOKEN}`）—— 两处都要收
    // URL 类传输（streamableHttp 与 sse）都要收 headers + url 占位符；
    // 2026-10-17 修：sse 曾落到 stdio 分支，导致 `?key=${TENCENT_MAP_KEY}` 这类漏收 → env 空、标成可直接连。
    const vars = (isHttp || isSse)
      ? placeholders({ ...(s.headers || {}), __url: url })
      : placeholders({ a: (s.args || []).join(' ') });
    // token-schema.json：鉴权字段的富元数据（中文 label / docUrl / placeholder 说明去哪拿 key）
    const tokenSchema = readJson(path.join(WB, dir, 'token-schema.json')) || {};
    const fieldMeta = new Map((tokenSchema.fields || []).map((f) => [f.key, f]));
    // manual（无启动信息）又没有可填字段 ⇒ 收录了也点不动。
    // connector-catalog 的门禁明确要求「manual 必须声明 env_vars」，这里提前过滤，别把脏数据写进目录。
    if (install.type === 'manual' && !vars.length) { skipped.manual++; continue; }
    const needsAuth = vars.length > 0;
    const needsCli = mcp.preAuth === 'cli';
    // 授权命令来自 cli.json 的 auth（按平台取，缺则退回 darwin）
    const authCommand = needsCli && cli.auth ? (cli.auth[process.platform] || cli.auth.darwin || '') : '';
    // 命令的第一个词如果是独立 CLI（不是 npx/uvx/docker），说明用户得先装它
    const cliBinary = authCommand ? authCommand.trim().split(/\s+/)[0] : '';
    const needsSeparateCli = !!cliBinary && !['npx', 'npm', 'uvx', 'docker'].includes(cliBinary);
    const host = url ? (() => { try { return new URL(url).host; } catch { return ''; } })() : '';

    const entry = {
      id: `wb-${dir}${Object.keys(servers).length > 1 ? `-${serverName}` : ''}`,
      name: serverName,
      display_name: serverName,
      vendor: 'WorkBuddy 目录',
      official: false,
      category: '导入连接器（WorkBuddy）',
      transport: isHttp ? 'http' : isSse ? 'sse' : 'stdio',
      install: authCommand ? { ...install, auth_command: authCommand } : install,
      env_vars: vars.map((n) => {
        const meta = fieldMeta.get(n) || {};
        return {
          name: n,
          // 中文 label（此前直接用变量名，如 "API_KEY"，表单对用户没有信息量）
          label: meta.label || meta.label_en || n,
          required: true,
          // 点「如何获取」直接跳官方文档（schema 顶层 docUrl，94% 的条目都有）
          docs_url: tokenSchema.docUrl || '',
        };
      }),
      description: String(s.description || s.title || '').slice(0, 300),
      capabilities: [],
      permissions: host ? [{ level: 'network', scope: host }] : [],
      auth_type: needsAuth ? 'api_key' : needsCli ? 'oauth' : 'none',
      official_url: '',
      maturity: 'imported',
      notes: [
        isSse ? 'SSE 传输（GET 建流 + POST 投递）；若连接失败请优先检查该服务是否已下线 SSE 端点' : '',
        needsCli && authCommand
          ? `需先在终端执行授权：${authCommand}${needsSeparateCli ? `（需要先安装 ${cliBinary} 命令行工具）` : ''}`
          : '',
        needsAuth ? `需要在连接器面板填写：${vars.join('、')}` : '',
        // placeholder 是「去哪拿 key」的具体步骤（如「登陆 3Chat -> 开放平台 -> OAuth -> 创建并获取 APP KEY」）。
        // 表单只渲染 name/label/docs_url，放不进 placeholder，所以写进备注，用户能读到。
        vars.map((n) => (fieldMeta.get(n) || {}).placeholder).filter(Boolean).join('；'),
        // 反例：token-schema 声明了必填字段，但 mcp.json 里既没有 header 模板也没有 url 占位符
        // ⇒ 我们无法确定注入位置。如实告知，别让用户以为「填了就行」。
        !vars.length && (tokenSchema.fields || []).length
          ? `该服务在目录里声明了 ${(tokenSchema.fields || []).map((f) => f.key).join('、')}，但未给出注入方式（可能需在服务方控制台配置），连接前请先看其文档`
          : '',
        // 无模板 ≠ 免鉴权：实测抽样 24 个"无 headers 声明"的端点，21 个返回 401。
        // 这条提示让用户在 401 时知道下一步做什么，而不是以为工具坏了。
        isHttp && !needsAuth && !needsCli
          ? '目录未声明鉴权方式；若连接返回 401，说明该服务需要令牌，请按其文档获取后填入 Authorization'
          : '',
      ].filter(Boolean).join('；'),
      auth_mode: needsAuth ? 'paste_key' : needsCli ? 'oauth' : 'none',
      recommended: false,
    };
    added.push(entry);
    if (key) seenUrls.add(key);
    if (install.pkg) seenPkgs.add(String(install.pkg).toLowerCase());
    seenNames.add(serverName.toLowerCase());
  }
}

console.log(`WorkBuddy 目录：${WB}`);
console.log(`主目录：${CURATED}（${curated.connectors.length} 条，仅用于去重）`);
console.log(`输出文件：${TARGET}`);
console.log(`\n可追加 ${added.length} 条；跳过：重复 ${skipped.dup}、SSE（--no-sse）${skipped.sse}、无服务 ${skipped.noServer}、坏 JSON ${skipped.badJson}、manual 无字段 ${skipped.manual}`);
const byType = added.reduce((m, c) => { m[c.install.type] = (m[c.install.type] || 0) + 1; return m; }, {});
console.log('追加构成：', byType);
console.log('其中需填 key 的：', added.filter((c) => c.auth_mode === 'paste_key').length,
  '；需先跑 CLI 授权的：', added.filter((c) => c.auth_mode === 'oauth').length);
if (sseList.length) console.log('SSE 条目（未导入）：', sseList.slice(0, 8).join(', '), sseList.length > 8 ? '…' : '');
console.log('\n前 5 条示例：');
for (const c of added.slice(0, 5)) console.log(`  ${c.id}  ${c.transport}  ${c.install.url || c.install.pkg}  auth=${c.auth_mode}`);

if (!WRITE) {
  console.log('\n（预览模式，未写盘。加 --write 实际合并）');
  process.exit(0);
}

const out = {
  schema_version: '1.0',
  generated_at: new Date().toISOString(),
  source: 'workbuddy-connectors-marketplace',
  description: `从本机 WorkBuddy 连接器目录（~/.workbuddy/connectors-marketplace/connectors）导入的 MCP 服务定义，共 ${added.length} 条。id 前缀 wb-。与 ecosystem/mcp-connectors.json（精选、≤90 条）分开存放，由 main/ecosystem.js 合并加载；主目录优先，按 url/name 去重。`,
  connectors: added,
};
fs.writeFileSync(TARGET, JSON.stringify(out, null, 2) + '\n');
console.log(`\n✅ 已写入 ${TARGET}，共 ${added.length} 条`);

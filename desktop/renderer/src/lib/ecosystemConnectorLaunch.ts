// 生态连接器「已下载 → 可连接」启动计划（纯函数，无 React 依赖，可单测）
// 背景：下载模型此前只写本地清单，连接器在「+」菜单永远停在「待配置」且无入口——
// 目录数据本就带 install/transport/env_vars（唯一事实源），点击时即可生成
// mcp:connect payload：能自动配置的直接连，缺凭证的就地引导填写。
//   npm    → npx -y <pkg> [args]
//   uvx    → uvx <pkg> [args]
//   docker → docker [args]
//   remote → http <url>（oauth/api_key/token 先收集 Authorization，可跳过直连）
//   manual → 无自动启动信息，引导「设置 → MCP 服务」+ 官方文档
// args 中的 ${VAR} 占位符与必填 env_vars 由调用方表单收集后回填 values。

export interface EnvVarSpec {
  name: string;
  label?: string;
  required?: boolean;
  docs_url?: string;
}

export interface ConnectorLike {
  name?: string;
  transport?: string;
  auth_type?: string;
  official_url?: string;
  install?: { type?: string; pkg?: string; args?: string[]; url?: string; headers?: Record<string, string> };
  env_vars?: EnvVarSpec[];
}

export interface ConnectPayload {
  transport: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface MissingVar {
  name: string;
  label: string;
  docs_url?: string;
}

export type LaunchPlan =
  | { kind: 'ready'; payload: ConnectPayload }
  | { kind: 'needs-config'; missing: MissingVar[] }
  | { kind: 'needs-auth'; missing: MissingVar[] }
  | { kind: 'manual' };

const PLACEHOLDER_RE = /\$\{(\w+)\}/g;

function argPlaceholders(args: string[]): string[] {
  const found = new Set<string>();
  for (const a of args) {
    for (const m of String(a).matchAll(PLACEHOLDER_RE)) found.add(m[1]);
  }
  return [...found];
}

function resolveArgs(args: string[], values: Record<string, string>): string[] {
  return args.map((a) => String(a).replace(PLACEHOLDER_RE, (_, k) => values[k] ?? ''));
}

// 远程 http 连接的 payload。
//
// 2026-10-17 修复（「大量需要授权的连接器填了 key 仍 401」的根因）：
//   原实现只认 values.Authorization 一个 header。而真实连接器（WorkBuddy 目录 270 家）
//   用的是各种模板：`X-Api-Key: ${API_KEY}`、`Authorization: Bearer ${API_KEY}`、
//   `X-Goog-Api-Key: ${...}`、`token: ${...}`…… 用户填了 key，注入不到对应 header，
//   服务端只看到空 header → 恒 401，且界面显示"已配置"，属**静默失败**。
//   现在按 install.headers 模板逐条替换；支持同一模板里多个变量。
// Authorization 仍作兼容入口：模板没声明它时，用户直接粘整条令牌也能用。
export function remotePayload(c: ConnectorLike, values: Record<string, string> = {}): ConnectPayload | null {
  const install = c.install || {};
  const url = install.url;
  if (!url) return null;
  // URL 里也可能有 ${VAR}（很多服务把 key 放 query，如 `?token=${TUSHARE_TOKEN}`）。
  // 2026-10-17 修复：此前只替换 header，导致「填了 key 仍 400/401」——
  // 因为发出去的是字面量 `${TUSHARE_TOKEN}`。
  // 任一处变量缺失就返回 null：宁可让调用方提示"还差什么"，也不要带着空 token 去请求
  // （那会被服务端当成无效凭证，错误信息反而误导用户在别处找原因）。
  let missingVar = '';
  const fill = (tpl: string) => String(tpl).replace(PLACEHOLDER_RE, (_, name: string) => {
    const got = (values[name] || '').trim();
    if (!got) { missingVar = missingVar || name; return ''; }
    return got;
  });
  const resolvedUrl = fill(url);
  if (missingVar) return null;
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(install.headers || {})) {
    if (!raw) continue;
    missingVar = '';
    const value = fill(raw);
    // 缺变量时**不**发送该 header（发半截模板比不发更难排查）
    if (!missingVar) headers[key] = value;
  }
  const auth = (values.Authorization || '').trim();
  if (auth && !headers.Authorization) headers.Authorization = auth;
  // 2026-10-17：SSE 与 streamableHttp 的投递语义不同（GET 建流 + POST 到 endpoint），
  // 传输类型必须原样传下去，否则主进程会按 streamableHttp 直接 POST 建流地址，必然失败。
  const kind = String(c.transport || '').toLowerCase() === 'sse' ? 'sse' : 'http';
  return { transport: kind, url: resolvedUrl, headers };
}

/**
 * 远程连接需要用户提供的变量名（去重）：**headers 模板 + url 里的占位符**。
 * 2026-10-17：此前只看 headers，漏掉 `?token=${X}` 这类把 key 放 query 的服务，
 * 于是它们被标成"可直接连接"，点了必然失败。
 */
export function headerPlaceholders(c: ConnectorLike): string[] {
  const install = c.install || {};
  const found = new Set<string>();
  for (const raw of Object.values(install.headers || {})) {
    for (const m of String(raw || '').matchAll(PLACEHOLDER_RE)) found.add(m[1]);
  }
  for (const m of String(install.url || '').matchAll(PLACEHOLDER_RE)) found.add(m[1]);
  return [...found];
}

export function buildLaunchPlan(c: ConnectorLike, values: Record<string, string> = {}): LaunchPlan {
  const install = c.install || {};
  const type = String(install.type || 'manual').toLowerCase();
  const auth = String(c.auth_type || '').toLowerCase();

  // 2026-10-16（用户实测 ima 反馈）：manual 检查必须**先于** needs-config——
  // ima 条目 install={type:'manual'} 但带 required env_vars，原实现先算 missing
  // → 返回 needs-config 假表单（出现输入框+保存按钮），填齐后重算又落回 manual
  // → 保存无响应/表单震荡，用户感知为「不让保存、关闭后要求重输」。
  // manual = 目录未登记启动信息，Key 无处注入，恒指引手动配置。
  if (type === 'manual' || (type !== 'remote' && type !== 'npm' && type !== 'uvx' && type !== 'docker')) {
    return { kind: 'manual' };
  }

  // 远程 HTTP：分三种情况
  //   ① 目录带 header 模板 → 按模板变量收集值（缺哪个收哪个），齐了就直连
  //   ② 无模板且 auth_type=none → 匿名直连
  //   ③ 无模板但声明了 auth_type → 引导粘贴整条令牌（Authorization）
  if (type === 'remote' && install.url) {
    const vars = headerPlaceholders(c);
    if (vars.length) {
      const missing = vars
        .filter((n) => !(values[n] || '').trim())
        .map((n) => {
          const spec = (c.env_vars || []).find((v) => v.name === n);
          return { name: n, label: spec?.label || n, docs_url: spec?.docs_url || c.official_url };
        });
      return missing.length
        ? { kind: 'needs-auth', missing }
        : { kind: 'ready', payload: remotePayload(c, values) as ConnectPayload };
    }
    if (!auth || auth === 'none') return { kind: 'ready', payload: remotePayload(c, values) as ConnectPayload };
    const filled = (values.Authorization || '').trim();
    return filled
      ? { kind: 'ready', payload: remotePayload(c, values) as ConnectPayload }
      : { kind: 'needs-auth', missing: [{ name: 'Authorization', label: 'Authorization', docs_url: c.official_url }] };
  }

  // stdio 系：占位符参数 + 必填环境变量缺值 → 就地引导配置
  const args = install.args || [];
  const missing: MissingVar[] = [
    ...argPlaceholders(args).filter((p) => !values[p]).map((p) => ({ name: p, label: p })),
    ...(c.env_vars || [])
      .filter((v) => v && v.required && !values[v.name])
      .map((v) => ({ name: v.name, label: v.label || v.name, docs_url: v.docs_url })),
  ];
  if (missing.length) return { kind: 'needs-config', missing };

  const env: Record<string, string> = {};
  for (const v of c.env_vars || []) if (v && values[v.name]) env[v.name] = values[v.name];

  if (type === 'npm' && install.pkg) {
    return { kind: 'ready', payload: { transport: 'stdio', command: 'npx', args: ['-y', install.pkg, ...resolveArgs(args, values)], env } };
  }
  if (type === 'uvx' && install.pkg) {
    return { kind: 'ready', payload: { transport: 'stdio', command: 'uvx', args: [install.pkg, ...resolveArgs(args, values)], env } };
  }
  if (type === 'docker') {
    return { kind: 'ready', payload: { transport: 'stdio', command: 'docker', args: resolveArgs(args, values), env } };
  }
  // manual 或缺包名：无自动启动信息
  return { kind: 'manual' };
}

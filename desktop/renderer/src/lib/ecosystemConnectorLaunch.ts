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
  install?: { type?: string; pkg?: string; args?: string[]; url?: string };
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

// 远程 http 连接的 payload（Authorization 可选：留空即匿名直连，失败如实透出）
export function remotePayload(c: ConnectorLike, values: Record<string, string> = {}): ConnectPayload | null {
  const url = (c.install || {}).url;
  if (!url) return null;
  const auth = (values.Authorization || '').trim();
  return { transport: 'http', url, headers: auth ? { Authorization: auth } : {} };
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

  // 远程 HTTP：无需授权直接就绪；需授权的引导粘贴令牌（可跳过）
  if (type === 'remote' && install.url) {
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

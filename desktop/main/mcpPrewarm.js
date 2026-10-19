'use strict';
// 期 1 / 期 2（2026-10-18）：MCP 预热白名单 + 懒启动灰度开关 + 三层权限分级（纯函数，无 electron 依赖）
//
// 三层权限模型落地：
//   ① auto-start —— 开箱即用刚需、低风险、无外部强鉴权、稳定通用：filesystem（工作区沙盒读写）/
//      time（时区与日期计算）/ fetch（已知 URL 只读抓取）。随启动拉起。
//   ② whitelist —— 中风险/无需外部密钥但非刚需：git、playwright（浏览器自动化）、desktop-commander
//      （宿主 shell）、memory、context7、deepwiki… 默认**不**随启动拉起，按需懒启动；
//      「开发者档（profile=developer）」可额外把 git 类纳入自动启动。
//   ③ manual —— 高危/付费/第三方/带外部密钥：云与基础设施（aws/azure/kubernetes…）、消息与邮件
//      （slack/gmail/discord…）、支付（stripe/paypal…）、第三方 SaaS API（github/notion/atlassian…）。
//      **绝不允许默认自启**，仅允许用户手动显式授权添加（这是架构红线，见 project_memory）。
//
// 架构红线（不可违背）：
//   · 默认自启只能是「原生工具 + 少量无密钥 MCP」；
//   · 带外部密钥 / 宿主命令行 / 浏览器自动化的 MCP 一律只进白名单懒加载或手动授权；
//   · Terminal/Shell 类（desktop-commander）绝不默认自启。
//
// 生效纪律（第六轮 G2+N8）：三层分级**默认生效**——启动只拉起 auto-start 档，whitelist/manual
// 一律按需懒连接。仅当显式设置 MJCODE_MCP_LAZY=0/false/off 时才回落到旧行为（启动全量重连），
// 该开关只用于排障/兼容，不作为常规运行路径。

// ── 三层分级枚举 ──
const TIER = Object.freeze({
  AUTO_START: 'auto-start',
  WHITELIST: 'whitelist',
  MANUAL: 'manual',
});

// ── auto-start：预热白名单（随启动拉起）──
const PREWARM_NAMES = new Set(['filesystem', 'time', 'fetch']);
// 兜底匹配：用户可能把服务重命名（自定义 name），此时按启动包名判定，避免白名单在该场景失效。
const PREWARM_PKGS = [
  '@modelcontextprotocol/server-filesystem',
  'mcp-server-time',
  'mcp-server-fetch',
];

// ── 开发者档额外自动启动（本地仓库操作，无外部密钥、无宿主 shell）──
const DEVELOPER_AUTO_START_NAMES = new Set(['git', 'git-mcp']);
const DEVELOPER_AUTO_START_PKGS = [
  'mcp-server-git',
  'mcp-server-git-mcp',
  'git-mcp',
  '@modelcontextprotocol/server-git',
];

// ── manual：高危/付费/第三方/带外部密钥（绝不默认自启，仅手动显式授权添加）──
// 判定口径：需要外部凭证（API Key/OAuth/连接串），或写入外部系统（云资源/消息/支付/SaaS）。
// 名单与 ecosystem/mcp-connectors.json 的 name 字段一一对应（77 条目录中需要外部授权的那些）。
const MANUAL_NAMES = new Set([
  // 云 / 基础设施 / 数据库
  'aws', 'cloudflare', 'google-bigquery', 'azure', 'vercel', 'docker-mcp', 'kubernetes',
  'terraform', 'supabase', 'mongodb', 'neon', 'redis', 'clickhouse', 'elastic',
  // 消息 / 邮件 / 协作 SaaS
  'slack', 'slack-local', 'gmail', 'google-drive', 'google-calendar', 'discord', 'telegram',
  'lark-mcp', 'dingtalk-mcp', 'intercom', 'zendesk', 'hubspot',
  // 支付 / 电商
  'stripe', 'paypal', 'square', 'shopify-dev',
  // 可观测 / 分析
  'sentry', 'posthog', 'grafana', 'clarity',
  // 第三方 API / 设计 / 数据 / 生成
  'github', 'gitlab', 'notion', 'notion-local', 'atlassian', 'linear', 'zapier', 'n8n',
  '1password', 'figma', 'figma-devmode', 'postman',
  'huggingface', 'apify', 'browserbase', 'firecrawl', 'exa', 'brave-search', 'tavily',
  'perplexity', 'replicate', 'elevenlabs', 'cloudinary', 'blender',
  'mem0', 'qdrant', 'pinecone', 'graphiti',
]);
// 包名兜底：少数高频高危包，防止用户重命名后误入白名单被开发者档自动拉起。
const MANUAL_PKGS = [
  'aws-mcp', 'mcp-server-kubernetes', 'stripe-mcp', 'server-slack', 'mcp-server-github',
  'mcp-server-notion', 'tavily-mcp', 'brave-search-mcp', 'exa-mcp', 'firecrawl-mcp',
];

// 档位枚举：normal（普通用户）/ developer（开发者）
const PROFILES = Object.freeze({ NORMAL: 'normal', DEVELOPER: 'developer' });

/**
 * tier 分级（懒启动）是否生效。**默认开启**：缺省/空/任意非关闭值一律为开启，
 * 启动仅拉起 auto-start 档（developer 档另含 git 类），whitelist/manual 按需连接。
 * 仅显式设置 '0' / 'false' / 'off' 时关闭，回落为「启动全量重连已保存服务」（排障兼容）。
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
function isLazyMode(env = process.env) {
  const v = String((env && env.MJCODE_MCP_LAZY) || '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

/** 归一化 profile：仅接受 'developer'，其余一律回落到 'normal'。 */
function normalizeProfile(v) {
  return String(v || '').trim().toLowerCase() === PROFILES.DEVELOPER ? PROFILES.DEVELOPER : PROFILES.NORMAL;
}

/** 读一份原始治理偏好对象 → 规范化治理配置（缺省值即「最保守」：normal / 读写 / 沙盒禁网）。 */
function readGovernance(pref) {
  const g = pref && typeof pref === 'object' ? pref : {};
  return {
    profile: normalizeProfile(g.profile),
    // 文件能力档：read-only（模型只能读）/ read-write（默认，可写）
    fsMode: g.fsMode === 'read-only' ? 'read-only' : 'read-write',
    // 沙盒代码执行的默认网络开关（默认关闭 = fail-closed）
    sandboxNetwork: g.sandboxNetwork === true,
  };
}

/** 该已保存配置是否属于「预热白名单」（按 name 精确匹配 或 按启动包名兜底）。 */
function isPrewarmTarget(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  const name = String(cfg.name || '').trim().toLowerCase();
  if (PREWARM_NAMES.has(name)) return true;
  const launch = `${cfg.command || ''} ${Array.isArray(cfg.args) ? cfg.args.join(' ') : ''} ${cfg.url || ''}`.toLowerCase();
  return PREWARM_PKGS.some((p) => launch.includes(p));
}

/** 开发者档额外自动启动项（git 类）。 */
function isDeveloperAutoStart(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  const name = String(cfg.name || '').trim().toLowerCase();
  if (DEVELOPER_AUTO_START_NAMES.has(name)) return true;
  const launch = `${cfg.command || ''} ${Array.isArray(cfg.args) ? cfg.args.join(' ') : ''} ${cfg.url || ''}`.toLowerCase();
  return DEVELOPER_AUTO_START_PKGS.some((p) => launch.includes(p));
}

/** 是否为需手动显式授权的第三方/高危服务（manual 档）。 */
function isManualTarget(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  const name = String(cfg.name || '').trim().toLowerCase();
  if (MANUAL_NAMES.has(name)) return true;
  const launch = `${cfg.command || ''} ${Array.isArray(cfg.args) ? cfg.args.join(' ') : ''} ${cfg.url || ''}`.toLowerCase();
  return MANUAL_PKGS.some((p) => launch.includes(p));
}

/**
 * 服务的内在档位分级（与登录/平台无关，是服务自身风险属性的函数）。
 * 纯本地无密钥但非刚需 → whitelist；需外部密钥/写入外部系统 → manual。
 * @returns {'auto-start'|'whitelist'|'manual'}
 */
function classifyTier(cfg) {
  if (isPrewarmTarget(cfg)) return TIER.AUTO_START;
  if (isManualTarget(cfg)) return TIER.MANUAL;
  return TIER.WHITELIST;
}

/**
 * 依据 profile 选出「启动时应自动拉起」的服务子集。
 *   · normal：仅 auto-start 档（filesystem/time/fetch）
 *   · developer：auto-start 档 + git 类（额外纳入）
 * manual 档**永不**自动拉起（架构红线）。
 */
function autoStartConfigs(configs, { profile } = {}) {
  const p = normalizeProfile(profile);
  return (Array.isArray(configs) ? configs : []).filter((cfg) => {
    const tier = classifyTier(cfg);
    if (tier === TIER.AUTO_START) return true;
    if (tier === TIER.WHITELIST && p === PROFILES.DEVELOPER && isDeveloperAutoStart(cfg)) return true;
    return false;
  });
}

/** 期 1 兼容入口：等价于 normal 档的自动启动子集（保持既有调用方与单测不断裂）。 */
function selectPrewarm(configs) {
  return autoStartConfigs(configs, { profile: PROFILES.NORMAL });
}

module.exports = {
  TIER, PROFILES,
  PREWARM_NAMES, PREWARM_PKGS,
  DEVELOPER_AUTO_START_NAMES, MANUAL_NAMES, MANUAL_PKGS,
  isLazyMode, normalizeProfile, readGovernance,
  isPrewarmTarget, isDeveloperAutoStart, isManualTarget,
  classifyTier, autoStartConfigs, selectPrewarm,
};

// 插件市场数据层：封装 window.mjcode.marketXxx 主进程通道
// 与 lib/api.js 并列：市场功能完全本地（主进程直接读盘），不依赖服务端在线

import { tGlobal } from '../i18n';

// 桥接缺失时给出明确文案，避免渲染层直接抛 undefined
function bridge() {
  const api = typeof window !== 'undefined' ? window.mjcode : null;
  if (!api) throw new Error(tGlobal('runtime.bridgeNotReady'));
  return api;
}

async function call(fn, fallback, ...args) {
  try {
    return await bridge()[fn](...args);
  } catch (e) {
    return fallback(e.message || tGlobal('runtime.callFailed'));
  }
}

export const market = {
  // ── 注册中心 ──
  // 拉取市场索引（远端热更新，失败回落本地缓存）
  refreshIndex: () => call('marketRefresh', (msg) => ({ ok: false, error: msg })),
  // 浏览/搜索市场条目
  search: (options = {}) => call('marketSearch', (msg) => ({ ok: false, error: msg, plugins: [] }), options),
  // 从 git 地址直接安装（P1 手动装路径）
  installFromGit: (payload) => call('marketInstallGit', (msg) => ({ ok: false, error: msg }), payload),

  // ── 已安装插件 ──
  listInstalled: () => call('marketListInstalled', (msg) => ({ ok: false, error: msg, plugins: [] })),
  // 读取单个插件的权限面板详情
  inspect: (name) => call('marketInspect', (msg) => ({ ok: false, error: msg }), { name }),
  // 启停插件（停用后运行时权限闸门直接拒绝）
  setEnabled: (payload) => call('marketSetEnabled', (msg) => ({ ok: false, error: msg })),
  // 卸载插件
  uninstall: (payload) => call('marketUninstall', (msg) => ({ ok: false, error: msg })),

  // 运行时权限实扣查询：某插件是否被授予某级别
  checkPermission: (payload) => call('marketCheckPermission', (msg) => ({ ok: false, error: msg, allow: false })),

  // 技能列表：市场安装的技能包已并入现有技能列表（由主控在 skills:list 侧接线）
  listSkills: () => call('listSkills', (msg) => ({ ok: false, error: msg, skills: [] })),
};

// 权限级别 i18n key（与主进程 summarizePermissions 保持一致的展示口径；渲染层经 t() 求值）
export const PERMISSION_LABELS = {
  filesystem: 'market.permFilesystem',
  network: 'market.permNetwork',
  shell: 'market.permShell',
};

// 插件形态 i18n key
export const TYPE_LABELS = {
  mcp: 'market.typeMcp',
  skill: 'market.typeSkill',
  prompt: 'market.typePrompt',
};

// 签名状态（fail-closed 口径）：返回 key + 插值参数，渲染层经 t() 求值
export function signatureLabel(plugin) {
  if (!plugin || !plugin.signature) return { textKey: 'market.sigUnsigned', cls: 'text-danger' };
  if (String(plugin.signature).startsWith('sigstore:')) {
    return plugin.publisher
      ? { textKey: 'market.sigSignedPublisher', vars: { publisher: plugin.publisher }, cls: 'text-success' }
      : { textKey: 'market.sigSigstore', cls: 'text-success' };
  }
  if (String(plugin.signature).startsWith('sha256:')) return { textKey: 'market.sigSha256Only', cls: 'text-warn' };
  return { textKey: 'market.sigUnknown', cls: 'text-danger' };
}
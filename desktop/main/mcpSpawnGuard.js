'use strict';
// MCP stdio 启动参数守卫（2026-10-18 启动日志审查 ① —— 从「假健康」到 fail-closed）
//
// 事故复盘（有日志证据）：
//   生态目录里 filesystem 连接器声明 args: ["${ALLOWED_DIR}"]（见 ecosystem/mcp-connectors.json）。
//   占位符由渲染层 buildLaunchPlan 收集用户填写后回填——但主进程侧连接路径里，
//   安装通道（ipc/plugins.js 的 `npx -y <pkg>`）与手工配置**都不会补这个参数**，
//   且连接前后没有任何校验。于是官方 filesystem 服务端带着「零允许目录」启动，
//   打出 `No valid root directories provided by client` 之后，仍以 14 个工具回报「连接成功」：
//   用户看到的是健康服务，实际每个工具调用都会失败 —— 典型静默失败。
//
// 守卫职责：spawn 之前拦下「参数没填全」的配置，给出可行动的修复指引。
// 为什么是 fail-closed：宁可连接失败并说明原因，也不要让一个功能上已死的服务
// 以「14 个工具」的健康姿态进入工具列表，把故障推迟到用户第一次真正调用工具时。

const PLACEHOLDER_RE = /\$\{(\w+)\}/;

/**
 * 校验 stdio 服务的启动参数是否可以安全 spawn。
 * @param {{name?: string, command?: string, args?: unknown[], env?: Record<string, unknown>}} spec
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function checkStdioSpawn({ name, command, args = [], env = {} } = {}) {
  const label = String(name || command || 'stdio 服务');
  const cmd = String(command || '');
  if (!cmd.trim()) {
    return { ok: false, error: `MCP 服务 ${label} 缺少启动命令，无法连接（请在设置或生态中心重新配置）` };
  }
  const cmdHit = cmd.match(PLACEHOLDER_RE);
  if (cmdHit) {
    return { ok: false, error: `MCP 服务 ${label} 的启动命令仍是未替换的占位符 \${${cmdHit[1]}}，拒绝连接` };
  }

  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i += 1) {
    const raw = String(list[i] ?? '');
    const hit = raw.match(PLACEHOLDER_RE);
    if (hit) {
      return {
        ok: false,
        error: `启动参数第 ${i + 1} 项仍是未替换的占位符 \${${hit[1]}}——请在生态中心重新配置「${label}」并填写该项后重连`,
      };
    }
    // 空参数是「占位符替换落空」的典型残留（npx -y <pkg> ''）。真实服务不存在合法空参数，
    // 而空参数往往意味着服务端会以「零配置」启动（如 filesystem 的零允许目录），故一并拦下。
    if (!raw.trim()) {
      return {
        ok: false,
        error: `启动参数第 ${i + 1} 项为空——通常是连接器必填项未填写（占位符替换落空）。`
          + `请在生态中心重新配置「${label}」，填写该项后再连接`,
      };
    }
  }

  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v !== 'string') continue;
    const hit = v.match(PLACEHOLDER_RE);
    if (hit) {
      return { ok: false, error: `环境变量 ${k} 仍是未替换的占位符 \${${hit[1]}}——请在生态中心重新配置「${label}」` };
    }
  }
  return { ok: true };
}

module.exports = { checkStdioSpawn, PLACEHOLDER_RE };

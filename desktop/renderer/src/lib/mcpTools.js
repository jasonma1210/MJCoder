// MCP 工具集管理（渲染层）：工具定义构造 + 启动恢复
// Bug3：应用重启后主进程自动重连 MCP，但渲染层 mcpTools 状态为空 →
//       启动时经 mcp:listTools 重建。

// server 工具清单 → OpenAI function 定义（agent-core 消费格式）
export function toToolDefs(server, tools) {
  return (tools || []).map((t) => ({
    type: 'function',
    function: {
      name: `mcp__${server}__${t.name}`,
      description: t.description || t.name,
      parameters: t.inputSchema || { type: 'object', properties: {} },
    },
  }));
}

// 启动时从主进程重建已连接服务的工具集（离线/无通道时返回空数组）
export async function restoreMcpTools() {
  try {
    const list = await window.mjcode?.mcpListTools?.();
    if (!Array.isArray(list)) return [];
    return list.flatMap(({ server, tools }) => toToolDefs(server, tools));
  } catch (e) {
    console.warn('[mcp] tool set rebuild failed:', e);
    return [];
  }
}

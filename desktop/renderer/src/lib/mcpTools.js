// MCP 工具集管理（渲染层）：工具定义构造 + 启动恢复
// Bug3：应用重启后主进程自动重连 MCP，但渲染层 mcpTools 状态为空 →
//       启动时经 mcp:listTools 重建。
// N5：`toToolDefs` 已收敛到 shared/mcpToolDefs.mjs（跨宿主唯一实现，主进程同源引用），
//     本文件不再自带副本，避免两条路径静默产出不同形状的工具定义。
// G9：重建时按「服务名 → 工具名」稳定排序，保证相同配置下披露序列字节稳定（前缀缓存友好）。
import { sortedToolDefs } from '../../../shared/mcpToolDefs.mjs';

// 启动时从主进程重建已连接服务的工具集（离线/无通道时返回空数组）
export async function restoreMcpTools() {
  try {
    const list = await window.mjcode?.mcpListTools?.();
    if (!Array.isArray(list)) return [];
    return sortedToolDefs(list);
  } catch (e) {
    console.warn('[mcp] tool set rebuild failed:', e);
    return [];
  }
}

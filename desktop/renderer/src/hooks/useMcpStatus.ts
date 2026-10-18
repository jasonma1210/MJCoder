// MCP 服务状态消费链路（P0-5④）—— React 绑定层
//
// 状态机（快照 / 事件归约 / 崩溃优先判定）在 `lib/mcpStatusState.ts`，本文件只负责两件事：
//   ① 用 useSyncExternalStore 把模块级快照接进 React（多消费方读同一份，不各自持有副本）；
//   ② 桥订阅只装一次（避免每个消费方各挂一个 ipcRenderer 监听）。
//
// 为什么拆开：状态机必须能在**纯 Node 宿主**里直接断言（本仓测试不挂 React）。
// 「崩溃标记被 ok 遮蔽」这个缺陷就是没有直测才漏掉的（详见 resolveMcpState 注释）。
import { useSyncExternalStore } from 'react';
import {
  applyMcpStatusEvent,
  clearMcpCrash,
  getMcpStatusSnapshot,
  resolveMcpState,
  subscribeMcpStatus,
  type McpCrashInfo,
  type McpServerState,
  type McpStatusEvent,
} from '../lib/mcpStatusState';

// 对外 API 保持不变（既有消费方 import 路径无需改动）
export { applyMcpStatusEvent, clearMcpCrash, resetMcpStatus, resolveMcpState } from '../lib/mcpStatusState';
export type { McpCrashInfo, McpServerState, McpStatusEvent, McpStatusSnapshot } from '../lib/mcpStatusState';

// 桥订阅：只装一次（模块级），避免每个消费方各挂一个 ipcRenderer 监听
let bridged = false;
function ensureBridge(): void {
  if (bridged) return;
  bridged = true;
  try {
    const bridge = typeof window !== 'undefined' ? window.mjcode : undefined;
    const on = bridge?.onTasksEvent as ((cb: (evt: McpStatusEvent) => void) => unknown) | undefined;
    if (typeof on !== 'function') {
      // 纯 Node 冒烟测试宿主没有 preload 桥：不报错，事件由 applyMcpStatusEvent 直接喂
      return;
    }
    on((evt) => applyMcpStatusEvent(evt));
  } catch (e) {
    console.warn('[mcp-status] subscribe failed:', e);
  }
}

export interface UseMcpStatusResult {
  /** 崩溃中的服务（name -> {code, ts}） */
  crashed: Record<string, McpCrashInfo>;
  /** 最近一次事件 */
  lastEvent: McpStatusEvent | null;
  /** 把崩溃叠加到派生状态上：崩溃标记优先（见 resolveMcpState 注释） */
  resolve: (name: string, derived: Exclude<McpServerState, 'crashed'>) => McpServerState;
  /** 重连成功后手动撤标记 */
  clearCrashed: (name: string) => void;
}

export function useMcpStatus(): UseMcpStatusResult {
  ensureBridge();
  const snap = useSyncExternalStore(subscribeMcpStatus, getMcpStatusSnapshot, getMcpStatusSnapshot);
  return {
    crashed: snap.crashed,
    lastEvent: snap.lastEvent,
    resolve: (name, derived) => resolveMcpState(snap.crashed, name, derived),
    clearCrashed: clearMcpCrash,
  };
}

export default useMcpStatus;

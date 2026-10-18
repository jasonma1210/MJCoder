// MCP 服务状态机（P0-5④ 的核心判定，**不依赖 React**）
//
// 从 hooks/useMcpStatus.ts 拆出：状态机（快照/事件归约/崩溃优先判定）与 React 绑定
// （useSyncExternalStore + 桥订阅）分开，原因是**状态机必须能在纯 Node 宿主里直接断言**——
// 本仓测试不挂 React，若状态逻辑留在 hook 文件里就只能靠 esbuild 打包才能测，
// 而「崩溃标记被 ok 遮蔽」这类缺陷正是没有直测才漏掉的（见 resolveMcpState 注释）。
//
// 设计取舍（原样保留）：
//   ① 不新增 IPC 通道：mcp_status 走既有 tasks:event 广播，按 type 过滤。
//   ② 主动断开 vs 崩溃由主进程区分（mcpClient 有 disconnecting 短路），本模块只按 status 映射。
//   ③ 五态 ok/fail/connecting/saved/crashed；事件只负责覆盖成 crashed，
//      任何后续非 crashed 状态立即撤标记。

/** 五态：前四态来自列表/本地操作，crashed 只来自主进程事件 */
export type McpServerState = 'ok' | 'fail' | 'connecting' | 'saved' | 'crashed';

/** 主进程 `mcp_status` 事件的形状（与 main/ipc/mcp.js:emitMcpStatus 对齐） */
export interface McpStatusEvent {
  type: string;
  name?: string;
  status?: string;
  code?: number | null;
  ts?: number;
}

export interface McpCrashInfo {
  /** 进程退出码（`error` 事件路径为 null） */
  code: number | null;
  /** 事件时间戳（毫秒） */
  ts: number;
}

export interface McpStatusSnapshot {
  /** name -> 崩溃信息：当前处于 crashed 态的服务 */
  crashed: Record<string, McpCrashInfo>;
  /** name -> 最近一次上报的状态原文（含未来新增的 status，便于诊断展示） */
  byName: Record<string, { status: string; ts: number }>;
  /** 最近一条 mcp_status 事件（状态条提示用） */
  lastEvent: McpStatusEvent | null;
}

// 非崩溃态不再需要保留：列表本身已经能表达 ok/fail/connecting/saved
const CRASHED = 'crashed';

let snapshot: McpStatusSnapshot = { crashed: {}, byName: {}, lastEvent: null };
const listeners = new Set<() => void>();

function publish(next: McpStatusSnapshot) {
  snapshot = next;
  for (const l of listeners) {
    try { l(); } catch (e) { console.warn('[mcp-status] listener failed:', e); }
  }
}

/** 订阅快照变化（hook 与纯 Node 测试共用） */
export function subscribeMcpStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const getMcpStatusSnapshot = (): McpStatusSnapshot => snapshot;

/** 处理一条事件（导出以便单测/纯 Node 宿主直接喂事件，不依赖 window） */
export function applyMcpStatusEvent(evt: McpStatusEvent | null | undefined): void {
  if (!evt || evt.type !== 'mcp_status') return;
  const name = typeof evt.name === 'string' ? evt.name : '';
  if (!name) return;
  const status = typeof evt.status === 'string' ? evt.status : '';
  const ts = typeof evt.ts === 'number' ? evt.ts : Date.now();
  const nextCrashed = { ...snapshot.crashed };
  if (status === CRASHED) {
    nextCrashed[name] = { code: evt.code == null ? null : Number(evt.code), ts };
  } else {
    // 重新连上 / 主动断开 / 任何后续状态都会撤下崩溃标记
    delete nextCrashed[name];
  }
  publish({
    crashed: nextCrashed,
    byName: status ? { ...snapshot.byName, [name]: { status, ts } } : snapshot.byName,
    lastEvent: evt,
  });
}

/** 清掉单个服务的崩溃标记（UI 重连成功后立即回落到派生态，不等下一次事件） */
export function clearMcpCrash(name: string): void {
  if (!name || !snapshot.crashed[name]) return;
  const nextCrashed = { ...snapshot.crashed };
  delete nextCrashed[name];
  publish({ ...snapshot, crashed: nextCrashed });
}

/** 测试/切库用：回到初始快照 */
export function resetMcpStatus(): void {
  publish({ crashed: {}, byName: {}, lastEvent: null });
}

/**
 * 把崩溃标记叠加到派生态上。**崩溃永远优先于派生态**。
 *
 * 为什么不能「派生态 ok 就以 ok 为准」：`derived === 'ok'` 来自上一次 `listServers` 的
 * **快照**，进程崩溃后它依然是「已连接」的陈旧值。若让 ok 优先，崩溃徽标与重连按钮
 * 永远不出现——这正是 P0-5④ 修复后仍不生效的根因。重连成功走 `clearMcpCrash` 显式
 * 撤标记，不需要靠「ok 优先」兜底。
 */
export function resolveMcpState(
  crashed: Record<string, McpCrashInfo>,
  name: string,
  derived: Exclude<McpServerState, 'crashed'>,
): McpServerState {
  return crashed[name] ? 'crashed' : derived;
}

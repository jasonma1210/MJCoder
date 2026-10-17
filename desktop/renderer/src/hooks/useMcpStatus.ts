// MCP 服务状态消费链路（P0-5④）
//
// 缺口：主进程早已产生并广播 `mcp_status` 事件（main/ipc/mcp.js 的 emitMcpStatus →
// deps.emitTaskEvent → webContents.send('tasks:event')），其中 mcpClient 会在**运行期**
// 子进程退出时上报 `crashed`（握手阶段退出不走这条，走握手失败分支）。但渲染层此前
// 零消费方（`grep mcp_status renderer/src` = 0），MCP 崩溃后 UI 仍停在「已连接」，
// 用户继续发消息只会不断拿到「工具不存在」——这就是 P0-5④ 要修的东西。
//
// 设计取舍：
//   ① 不新增 IPC 通道。`mcp_status` 走的是既有 `tasks:event` 广播（与编排事件同一条
//      channel），preload 已暴露 `onTasksEvent`，渲染层按 `type` 过滤即可。
//   ② 「主动断开」与「崩溃」的区分**由主进程负责**（mcpClient 有 `server.disconnecting`
//      短路：主动断开不上报 crashed）。本模块不猜测、不推断，只按事件里给的 status 映射。
//   ③ 状态五态：ok / fail / connecting / saved / crashed。前四态是「列表 + 本地操作」的
//      派生结果（连接成功、握手失败、连接中、仅落盘），事件只负责覆盖成 crashed；
//      一旦某服务再次上报非 crashed 状态（例如重连成功上报 ok），崩溃标记立即清除。
//   ④ 用模块级 store + useSyncExternalStore：多个消费方（本机服务区、状态条）读同一份
//      快照，不会各自持有一份 after-the-fact 的状态。
import { useSyncExternalStore } from 'react';

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

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const getSnapshot = (): McpStatusSnapshot => snapshot;

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
  /** 把崩溃叠加到派生状态上：派生态若已连上，则以实时连接为准（重连成功但事件未到） */
  resolve: (name: string, derived: Exclude<McpServerState, 'crashed'>) => McpServerState;
  /** 重连成功后手动撤标记 */
  clearCrashed: (name: string) => void;
}

export function useMcpStatus(): UseMcpStatusResult {
  ensureBridge();
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    crashed: snap.crashed,
    lastEvent: snap.lastEvent,
    resolve: (name, derived) => (derived === 'ok' ? 'ok' : (snap.crashed[name] ? 'crashed' : derived)),
    clearCrashed: clearMcpCrash,
  };
}

export default useMcpStatus;

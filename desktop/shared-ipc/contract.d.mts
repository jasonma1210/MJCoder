// T0-2 契约的 TypeScript 类型声明（供渲染层 tsc 门禁消费；运行时实现在 contract.mjs）
export const AGENT_CHANNELS: {
  readonly run: 'agent:run';
  readonly event: 'agent:event';
  readonly abort: 'agent:abort';
};

export type AgentEventType = 'message' | 'stream' | 'tool_call' | 'subagent' | 'todos' | 'suspended' | 'done' | 'error'
  | 'verify' | 'verify_ledger';

// P2-8 / V-L1（N7）：V 层判定事件（运行时 schema 见 contract.mjs verifyDataSchema）。
// 注意语义：verdict 只说明「模型自述与执行记录是否一致」，**不代表改动正确**
//（L1 只核「有没有发生」，不核「对不对」）——UI 文案不得写成「已验证正确」。
export interface VerifyEventData {
  level: 'l1' | 'l3';
  verdict: 'PASS' | 'BLOCK' | 'SKIP' | 'UNKNOWN';
  ruleId?: string;
  reason?: string;
  annotated: boolean;
  continued: boolean;
  ms?: number;
}

// 引擎侧执行事实快照（正常经 trace 落 JSONL，不经 agent:event；此处登记防降级）
export interface VerifyLedgerEventData {
  tools: number;
  entries: unknown[];
  truncated?: boolean;
  ms?: number;
}

// T1-3：子代理事件载荷（运行时 schema 见 contract.mjs subagentDataSchema）
export interface SubagentEventData {
  tool: 'spawn_subagent' | 'orchestrate_task';
  phase: 'spawn' | 'progress' | 'done' | 'failed';
  objective?: string;
  taskType?: string;
  groupId?: string;
  taskId?: string;
  title?: string;
  /** T1-4：DAG 依赖边（仅 orchestrate_task 的 spawn 事件携带） */
  dependsOn?: string[];
  tokens?: number;
  budgetKind?: string;
  round?: number;
  ms?: number;
  summary?: string;
  error?: string;
}

export interface AgentEventEnvelope {
  runId: string;
  type: AgentEventType;
  data: unknown;
}

// 校验结果联合：interface 不能直接写 `{} | {}`（T2-2 后该声明文件被渲染层 .ts import 链拉入 tsc 才暴露此语法错误）
export type ValidationResult<T> = { ok: true; data: T } | { ok: false; error: string };

export declare function validateAgentEvent(payload: unknown): { ok: true; data: AgentEventEnvelope } | { ok: false; error: string };
export declare function safeAgentEventEnvelope(payload: unknown): AgentEventEnvelope;
export declare function validateAgentRunPayload(payload: unknown): { ok: true; data: Record<string, unknown> } | { ok: false; error: string };
export declare function describeZodError(err: unknown): string;

// sandboxNotice.mjs 的 TypeScript 类型声明（运行时实现见同名 .mjs）
// 渲染层 tsc 门禁消费：与 shared-ipc/contract.d.mts 同一模式。

/** 主进程 tools/exec.js 会发出的沙箱/执行类错误码 */
export declare const SANDBOX_ERROR_CODES: readonly [
  'sandbox-unavailable',
  'command-guard-blocked',
  'shell-unavailable',
  'result-unknown',
  'exec-failed',
];

export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[number];

export interface SandboxNotice {
  code: SandboxErrorCode;
  /** 是否属于「已阻断、未产生副作用」 */
  blocked: boolean;
  /** 当前隔离策略档位（read-only / workspace-write / full-access / unknown） */
  policy: string;
  /** 本次是否真的运行在 OS 沙箱内 */
  sandboxed: boolean;
  /** 沙箱后端标识（seatbelt / bubblewrap / windows-restricted-user / none / unknown） */
  backend: string;
  /** 底层原因原文（已截断，可空） */
  detail: string;
  titleKey: string;
  reasonKey: string;
  actionKey: string;
  nextStepKey: string;
}

export declare function sandboxNoticeOf(result: unknown): SandboxNotice | null;

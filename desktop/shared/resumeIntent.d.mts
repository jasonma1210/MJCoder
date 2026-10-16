// resumeIntent.mjs 的 TypeScript 类型声明（运行时实现见同名 .mjs）

export type ResumeReason = 'checkpoint' | 'keyword-no-checkpoint' | 'no-checkpoint';

export interface ResumeDecision {
  /** 是否注入恢复上下文——只取决于是否存在断点 */
  resume: boolean;
  /** 消息是否表达「继续」意图（辅助信号，不参与放行） */
  looksLikeContinue: boolean;
  reason: ResumeReason;
}

export declare function looksLikeContinue(messageText: unknown): boolean;

export declare function resumeDecision(params?: {
  hasCheckpoint?: boolean;
  messageText?: unknown;
}): ResumeDecision;

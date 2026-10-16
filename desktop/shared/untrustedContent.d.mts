// untrustedContent.mjs 的 TypeScript 类型声明（运行时实现见同名 .mjs）
// 渲染层 tsc 门禁消费；与 shared-ipc/contract.d.mts 同一模式。

export type InjectionSeverity = 'high' | 'medium' | 'low';

export interface InjectionRule {
  id: string;
  severity: InjectionSeverity;
  re: RegExp;
}

export interface InjectionFinding {
  id: string;
  severity: InjectionSeverity;
  match: string;
}

export interface DetectResult {
  suspicious: boolean;
  findings: InjectionFinding[];
}

export interface WrapResult {
  text: string;
  truncated: boolean;
}

export interface ScanResult extends DetectResult, WrapResult {}

export declare const INJECTION_RULES: readonly InjectionRule[];

export declare function detectPromptInjection(
  content: unknown,
  options?: { minSeverity?: InjectionSeverity },
): DetectResult;

export declare function isSuspiciousPrompt(
  content: unknown,
  options?: { minSeverity?: InjectionSeverity },
): boolean;

export declare function wrapUntrusted(
  content: unknown,
  options?: { source?: string; label?: string; maxChars?: number },
): WrapResult;

export declare function scanUntrusted(
  content: unknown,
  options?: { source?: string; label?: string; maxChars?: number; minSeverity?: InjectionSeverity },
): ScanResult;

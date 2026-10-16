// 跨宿主共享的「沙箱/执行失败结构化说明」纯逻辑（零依赖，主进程 / 渲染层 / 测试三方同源）
//
// 背景（2026-10-16 修复 A3）：此前沙箱不可用时只把底层原文（operation not permitted、
// 「受限沙箱不可用」）透给用户与模型，用户无从判断「是网络被拦、文件被拦，还是隔离后端
// 根本没就绪」，而最危险的自救动作恰恰是「切到 full-access」——那是把隔离整体关掉。
//
// 本模块把主进程 tools/exec.js 发出的 errorCode 归一为四要素：
//   ① 原因 ② 受影响动作 ③ 当前档位与是否真的隔离 ④ 安全下一步（永不建议 full-access）
// 文案以 i18n key 形式给出，本文件不持有任何中文/英文字面量，避免与 i18n 门禁冲突。
//
// 为什么是 .mjs 而不是 .ts：渲染层（Vite）与 Node 测试都要能直接 import；
// 主进程为 CJS，需要时用动态 import（与 shared-ipc/contract.mjs 同一模式）。
// 类型由同目录 sandboxNotice.d.mts 提供给 tsc。

/** 主进程 tools/exec.js 会发出的沙箱/执行类错误码（唯一事实来源，新增需同步此处与 i18n） */
export const SANDBOX_ERROR_CODES = [
  'sandbox-unavailable',
  'command-guard-blocked',
  'shell-unavailable',
  'result-unknown',
  'exec-failed',
];

/** 错误码 → 标题 i18n key（显式映射，避免字符串拼接导致 i18n 扫描器无法静态发现 key） */
const TITLE_KEYS = {
  'sandbox-unavailable': 'runtime.sandboxUnavailableTitle',
  'command-guard-blocked': 'runtime.commandGuardBlockedTitle',
  'shell-unavailable': 'runtime.shellUnavailableTitle',
  'result-unknown': 'runtime.resultUnknownTitle',
  'exec-failed': 'runtime.execFailedTitle',
};

/** 错误码 → 原因 i18n key */
const REASON_KEYS = {
  'sandbox-unavailable': 'runtime.sandboxUnavailableReason',
  'command-guard-blocked': 'runtime.commandGuardBlockedReason',
  'shell-unavailable': 'runtime.shellUnavailableReason',
  'result-unknown': 'runtime.resultUnknownReason',
  'exec-failed': 'runtime.execFailedReason',
};

function asCode(v) {
  return typeof v === 'string' && SANDBOX_ERROR_CODES.includes(v) ? v : null;
}

function pickString(v) {
  return typeof v === 'string' ? v : '';
}

/**
 * 从工具结果中提取结构化沙箱说明。
 * @param {unknown} result 工具结果（形如 { stdout, stderr, exitCode, errorCode, sandbox }）
 * @returns {null | {
 *   code: string, blocked: boolean, policy: string, sandboxed: boolean, backend: string,
 *   detail: string, titleKey: string, reasonKey: string, actionKey: string, nextStepKey: string,
 * }} 命中沙箱/执行类错误码时返回说明，否则 null（与非沙箱类失败区分）
 */
export function sandboxNoticeOf(result) {
  if (!result || typeof result !== 'object') return null;
  const code = asCode(result.errorCode);
  if (!code) return null;

  const sb = (result.sandbox && typeof result.sandbox === 'object') ? result.sandbox : {};
  const policy = pickString(sb.policy) || pickString(result.sandboxPolicy) || 'unknown';
  const backend = pickString(sb.backend) || pickString(result.sandboxBackend)
    || (result.sandboxed === true ? 'unknown' : 'none');
  const sandboxed = sb.sandboxed === true || result.sandboxed === true;
  const detail = pickString(sb.reason) || pickString(result.stderr) || pickString(result.error);

  // Windows 后端经 schtasks 执行时无法回传结果，其下一步指引与其它平台不同。
  // 「结果不可知」是独立语义：命令**可能已执行**，因此单独一组文案，避免误导为「未执行」。
  const isWindows = /windows/i.test(backend);
  const nextStepKey = code === 'result-unknown'
    ? 'runtime.sandboxNextStepResultUnknown'
    : isWindows
      ? 'runtime.sandboxNextStepWindows'
      : 'runtime.sandboxNextStepGeneric';

  return {
    code,
    blocked: result.blocked === true || code === 'sandbox-unavailable' || code === 'command-guard-blocked',
    policy,
    sandboxed,
    backend,
    detail: detail.slice(0, 300),
    titleKey: TITLE_KEYS[code],
    reasonKey: REASON_KEYS[code],
    actionKey: code === 'result-unknown' ? 'runtime.sandboxActionExecutedUnknown' : 'runtime.sandboxActionNotExecuted',
    nextStepKey,
  };
}

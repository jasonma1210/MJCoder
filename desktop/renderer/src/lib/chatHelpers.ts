// @ts-nocheck -- T2-2 存量代码原样搬移（零行为变更）；渐进 TS 路线下补全类型属后续任务（T0-3 门禁只约束新文件扩展名）
// T2-2：对话域纯函数助手（自主进程 ChatArea.jsx 原样搬移，行为不变）。

// A12：ArrayBuffer → base64（分块，粘贴图片落盘用）
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// A4：数字员工 system prompt 模板（使命 + 行业 + 审批策略）
// 以下均为注入模型的 prompt 工程文案（非 UI 展示），按语言字面量豁免 i18n
export function buildExpertPrompt(e) {
  if (!e) return '';
  const lines = [
    `你现在扮演数字员工「${e.title_cn || e.name}」，全程以此身份与用户协作。`, // i18n-literal
    e.mission ? `使命：${e.mission}` : '', // i18n-literal
    (e.industry || []).length ? `行业背景：${e.industry.join('、')}` : '', // i18n-literal
    e.market_signal ? `专业视角：${e.market_signal}` : '', // i18n-literal
    `审批策略偏好：${e.approval_policy === 'trusted' ? '完全信任（仍需遵守系统安全约束）' : e.approval_policy === 'safe-auto' || e.approval_policy === 'auto-safe' ? '安全自动' : '按需向用户确认'}`, // i18n-literal
  ].filter(Boolean);
  return lines.join('\n');
}

// 从工具调用中提取被写入的文件路径（区分「AI 改的」与「我自己改的」）
const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file', 'apply_patch']);
export function agentFilesOf(tc) {
  if (!WRITE_TOOL_NAMES.has(tc?.name)) return [];
  if (tc.name === 'apply_patch') {
    const m = String(tc.args?.patch || '').match(/^\+\+\+ b\/(.+)$/m);
    return m ? [m[1].trim()] : [];
  }
  return tc.args?.path ? [String(tc.args.path)] : [];
}

// 项目显示名：磁盘目录名 ≠ 用户可读名
//
// 背景（真机反馈）：新建任务时输入框上方显示 `20261013-1271`——这是
// workspace.createProject 在「用户未命名」时生成的目录名（日期+4位随机数），
// 作为目录标识是合理的（唯一、可排序、无编码问题），但直接当 UI 文案给用户看
// 等于把内部 ID 泄漏到界面上：用户既不认识，也猜不出这是什么。
//
// 策略：显示名与目录名解耦。
//   - 目录名（project.path）永远不变——会话按 projectPath 归属、沙箱按目录授权
//   - 显示名优先用户自定义（项目重命名）；未自定义且形如机器名时，渲染为可读文案
//   - 完整目录路径始终通过 title 提示暴露，避免「显示名友好化」造成信息丢失
import { tGlobal } from '../i18n';

const STAMP_RE = /^(\d{4})(\d{2})(\d{2})-\d{4}$/;

/** UI 展示用：把 20261013-1271 这类机器名渲染成「工作区 10-13」（i18n 文案） */
export function projectDisplayName(project) {
  const raw = String(project?.name || '').trim();
  const m = STAMP_RE.exec(raw);
  if (m) return tGlobal('runtime.workspaceName', { month: m[2], day: m[3] });
  if (raw) return raw;
  const base = String(project?.path || '').split('/').filter(Boolean).pop();
  return base || tGlobal('runtime.unnamedProject');
}

/** 是否是「用户没起过名」的机器名（用于提示可重命名） */
export function isMachineName(project) {
  return STAMP_RE.test(String(project?.name || '').trim());
}

// macOS Seatbelt 沙箱：profile 生成（纯函数，可单测）+ 可用性探测 + 跨平台兜底守卫
const fs = require('fs');

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

// P0-S1：跨平台兜底守卫的危险命令规则改为与审批层**同源**（来自 dangerousPatterns.js）。
// 事故背景：此前这里是 12 条、approval.js 是 10 条，两份手抄副本各自漂移，
// 导致「审批层比沙箱层宽松」——两层守卫同时被绕过。现在两层共用同一份规则集，
// 从结构上杜绝再次漂移（新增危险模式只需改dangerousPatterns.js 一处）。
const { DANGEROUS_PATTERNS } = require('./dangerousPatterns');
// 保留旧名导出，避免外部引用断裂（测试与main.js 均按此名引用）
const FALLBACK_DANGEROUS = DANGEROUS_PATTERNS;

// 返回 { blocked: boolean, reason: string }
function checkCommandGuard(policy, command, platform = process.platform, execExists = true) {
  if (!policy || policy === 'full-access') return { blocked: false, reason: '' }; // 显式 full-access 是 opt-in，不拦
  const osSandbox = platform === 'darwin' && execExists;
  if (osSandbox) return { blocked: false, reason: '' }; // 有 OS 级沙箱，无需兜底
  const cmd = String(command || '');
  const hit = FALLBACK_DANGEROUS.find((p) => p.test(cmd));
  if (hit) {
    return { blocked: true, reason: `当前系统无 OS 级沙箱（仅 macOS Seatbelt），已按安全策略拦截危险命令：${cmd.slice(0, 120)}` };
  }
  return { blocked: false, reason: '' };
}

// 依据沙箱策略与项目目录生成 Seatbelt profile
// read-only: 只读 + 禁网；workspace-write: 项目目录与临时目录可写 + 禁网；full-access: 不沙箱
// 真机复盘（打包版）：zsh 等标准 shell 大量使用 `>/dev/null` 重定向（如 `cmd 2>/dev/null`），
// profile 未放行 /dev/null 写入 → 「operation not permitted: /dev/null」，模型被迫换写法浪费轮次。
// /dev/null 是字面黑洞设备，放行写入无任何数据外泄风险，两个档位统一 allow。
function buildSeatbeltProfile(policy, cwd) {
  const tmpPaths = ['/private/tmp', '/private/var/tmp', '/tmp'];
  const tmpRules = tmpPaths.map((p) => `(subpath "${p}")`).join(' ');
  if (policy === 'read-only') {
    return [
      '(version 1)',
      '(deny default)',
      '(allow file-read*)',
      '(allow process-exec)',
      '(allow process-fork)',
      '(allow sysctl-read)',
      '(allow mach-lookup)',
      '(deny file-write*)',
      // /dev/null 必须在 deny file-write* 之后：Seatbelt 后匹配规则优先生效
      '(allow file-write* (literal "/dev/null"))',
      '(deny network*)',
    ].join('\n');
  }
  const safeCwd = String(cwd || '').replace(/"/g, '\\"');
  const writeRule = safeCwd
    ? `(allow file-write* (subpath "${safeCwd}") ${tmpRules})`
    : `(allow file-write* ${tmpRules})`;
  return [
    '(version 1)',
    '(deny default)',
    '(allow file-read*)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    writeRule,
    // /dev/null 放行（deny default 已拒其余写入，此处显式允许该字面路径）
    '(allow file-write* (literal "/dev/null"))',
    '(deny network*)',
  ].join('\n');
}

// 沙箱可用性：仅 darwin 且 sandbox-exec 存在
function sandboxAvailable() {
  if (process.platform !== 'darwin') return false;
  try {
    return fs.existsSync(SANDBOX_EXEC);
  } catch (e) {
    return false;
  }
}

// 决策：本次 shell 是否应包沙箱
function shouldSandbox(policy, cwd) {
  if (!policy || policy === 'full-access') return { use: false, reason: 'full-access' };
  if (!sandboxAvailable()) return { use: false, reason: 'sandbox-exec 不可用' };
  if (policy === 'workspace-write' && !cwd) return { use: false, reason: 'workspace-write 需要项目目录' };
  return { use: true };
}

module.exports = { buildSeatbeltProfile, sandboxAvailable, shouldSandbox, checkCommandGuard, FALLBACK_DANGEROUS, SANDBOX_EXEC };

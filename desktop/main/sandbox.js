// macOS Seatbelt 沙箱：profile 生成（纯函数，可单测）+ 可用性探测 + 跨平台兜底守卫
const fs = require('fs');

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

// P0-F：跨平台兜底守卫（纯函数，可单测）
// 背景：Seatbelt 仅 macOS。Windows/Linux 上 workspace-write/read-only 策略没有 OS 级隔离，
// 此前只剩审批中心兜底——审批档位 'never' 或 always 规则一旦漏，LLM 生成的危险命令即裸跑。
// 兜底策略：OS 沙箱不可用且策略非 full-access 时，硬拦截危险命令模式（审批不可绕过、不可豁免）。
// 文档明示：这是「命令级硬拦截」，不是 OS 级隔离（与 Seatbelt 有本质差距）。
const FALLBACK_DANGEROUS = [
  /\brm\s+(-[a-zA-Z]*\s+)*-[rf]/, /\bsudo\b/, /\bgit\s+push\b/, /\bgit\s+reset\s+--hard\b/,
  /\bchmod\s+777\b/, /\bmkfs\b/, /\bdd\s+if=/, /:\(\}\)/, /\bshutdown\b/, /\breboot\b/,
  /\bcurl\b[^|]*\|\s*(ba)?sh/, /\bwget\b[^|]*\|\s*(ba)?sh/, // 管道远程脚本执行
];

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

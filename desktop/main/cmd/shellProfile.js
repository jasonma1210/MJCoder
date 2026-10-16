// main/cmd/shellProfile.js
// N2 ShellProfile（2026-10-16，方案 §8.1「命令请求分 argv 与 shell」）：
// 字符串命令的 shell 执行不再隐式依赖 child_process.exec 的默认 /bin/sh——
// 显式指定平台、可信 shell 路径、非交互参数，供 runner 直接 spawn（可 kill、可审计、无 rc 副作用）。
//
// 取舍：POSIX 侧保持 /bin/sh -c（与原 exec() 行为逐字一致，零语义漂移），
// 只是把它从「实现细节」升格为「显式契约」；/bin/sh 天然非交互、不加载 rc。
// Windows 用 cmd /d /s /c：/d 禁用 AutoRun 注册表项，/s 修正引号处理。
// argv 优先路径（模型给出 argv 数组时）完全绕开本模块——不经过任何 shell。

const fs = require('fs');

const IS_WIN = process.platform === 'win32';

const PROFILES = IS_WIN
  ? [{ exe: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c'], name: 'cmd' }]
  : [{ exe: '/bin/sh', args: ['-c'], name: 'sh' }];

let cached = null; // { profile, ok, reason, version }

/**
 * 解析并探测当前平台的 shell profile（进程级缓存）。
 * @returns {{ exe: string, args: string[], name: string, ok: boolean, reason: string, version: string }}
 */
function resolveShellProfile() {
  if (cached) return cached;
  const profile = PROFILES[0];
  let ok = false;
  let reason = '';
  let version = '';
  try {
    ok = fs.existsSync(profile.exe);
    if (!ok) {
      reason = `shell 不存在：${profile.exe}`;
    } else if (IS_WIN) {
      // cmd 无 --version；存在即可用
      version = 'cmd';
    } else {
      version = 'sh（POSIX）';
    }
  } catch (e) {
    ok = false;
    reason = `shell 探测失败：${e.message}`;
  }
  cached = { ...profile, ok, reason, version };
  return cached;
}

/** 测试辅助：清空缓存 */
function resetShellProfile() { cached = null; }

/**
 * POSIX 单引号转义拼接：argv 数组 → 等价 shell 字符串（仅用于**必须**走字符串 shell 的
 * 后端路径，如 Linux bwrap / Windows 受限用户；直接 execFile 的路径不需要它）。
 * Windows cmd 的引号语义与 POSIX 不同，此处为保守降级（文档已注明），非精确等价。
 */
function argvToShellCommand(argv) {
  return argv.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
}

module.exports = { resolveShellProfile, resetShellProfile, argvToShellCommand, IS_WIN };

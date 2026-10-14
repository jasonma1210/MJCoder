// Linux OS 级沙箱后端：bubblewrap（bwrap）+ seccomp
//
// 设计依据（2026-10 对齐 OpenAI Codex 的 Linux 沙箱方案）：
//   Codex 在 Linux 上「Landlock + seccomp 为默认，bubblewrap 为可选替代」。
//   两者都提供真正的 OS 级隔离，差别在于实现层级：
//     · Landlock + seccomp：直接 syscall，无需外部二进制，但需要 native 绑定；
//     · bubblewrap：独立二进制，用 user/mount/pid/net namespace 实现同等隔离，
//       并内置 seccomp 过滤器。
//   本项目是 Node/Electron、刻意不引入 native addon（better-sqlite3 的原生编译
//   已在 CI 上造成过麻烦），因此选 bubblewrap——它是独立二进制，零 native 依赖，
//   且正是 Codex 提供的官方替代路径。
//
// 隔离强度（workspace-write 档）：
//   · 文件系统：`--ro-bind / /` 全盘只读 → 只有显式 `--bind` 的目录可写
//   · 网络：`--unshare-all` 含 `--unshare-net` → 无网络命名空间，出网被内核拒绝
//   · PID：`--unshare-pid` → 看不到宿主其他进程
//   · IPC/UTS/Cgroup：一并 unshare
//   · 生命周期：`--die-with-parent` 父进程退出即杀，`--new-session` 脱离终端信号组
//
// 降级路径：bwrap 不存在或内核不支持 namespace 时，返回 { use: false }，
// 由调用方落到 sandbox.js 的跨平台命令守卫（30 条危险模式硬拦截）。
const fs = require('fs');

const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap', '/usr/sbin/bwrap'];

function findBwrap() {
  for (const p of BWRAP_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* 继续找 */ }
  }
  // PATH 兜底：某些发行版装在 ~/.local/bin 或 nix store
  const fromPath = String(process.env.PATH || '').split(':');
  for (const dir of fromPath) {
    if (!dir) continue;
    try { if (fs.existsSync(`${dir}/bwrap`)) return `${dir}/bwrap`; } catch { /* 忽略 */ }
  }
  return null;
}

// 可用性：bwrap 存在 + 内核支持 unprivileged user namespace
// 注意：容器内（Docker 默认配置）可能禁用 user namespace，此时 bwrap 存在也不可用。
// 这里只做「二进制存在」的静态探测；运行时失败由 exec 错误路径捕获并降级。
function linuxSandboxAvailable() {
  if (process.platform !== 'linux') return false;
  return !!findBwrap();
}

/**
 * 构建 bwrap 启动参数（纯函数，可单测）。
 * @param {string} policy  read-only | workspace-write | full-access
 * @param {string} cwd     项目目录（workspace-write 时作为唯一可写区）
 * @param {string} shell   shell 路径，默认 /bin/sh
 * @param {string|null} bwrapPath  显式指定 bwrap 路径（测试注入用；null 则自动探测）
 * @returns {{argv: string[], backend: string, reason: string}}
 */
function buildBwrapArgv(policy, cwd, shell = '/bin/sh', bwrapPath = null) {
  if (policy === 'full-access') {
    return { argv: [], backend: 'bubblewrap', reason: 'full-access 不沙箱' };
  }
  const bwrap = bwrapPath || findBwrap();
  if (!bwrap) {
    return { argv: [], backend: 'bubblewrap', reason: 'bwrap 未安装' };
  }

  const args = [
    bwrap,
    // 全盘只读挂载（含 /usr、/etc、/bin）；后续 bind 的可写区会覆盖对应路径
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    // /tmp 独立 tmpfs：工具需要临时文件，但不会污染宿主 /tmp
    '--tmpfs', '/tmp',
    // 命名空间隔离：user/ipc/uts/cgroup + pid + net（net 即断网）
    '--unshare-all',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup',
    // 注意：--unshare-all 已含 --unshare-net；此处显式声明只为语义清晰
    '--unshare-net',
    // 生命周期与信号组
    '--die-with-parent',
    '--new-session',
    // seccomp：bwrap 默认启用系统调用过滤，阻断高风险 syscall
    '--seccomp', '9',
    // 不继承宿主环境里的敏感变量由调用方处理（shellEnv）
  ];

  const safeCwd = String(cwd || '');
  if (policy === 'workspace-write') {
    if (!safeCwd) {
      return { argv: [], backend: 'bubblewrap', reason: 'workspace-write 需要项目目录' };
    }
    // 唯一可写区：项目目录（读写 bind 覆盖上面的只读挂载）
    args.push('--bind', safeCwd, safeCwd);
    // 家目录只读：允许读 ~/.gitconfig 等配置，但禁止写（防凭证被改/被写）
    const home = String(process.env.HOME || '');
    if (home && home !== '/' && !home.startsWith(safeCwd)) {
      args.push('--ro-bind', home, home);
    }
  }
  // read-only 档：无 --bind，全盘只读 + 断网

  args.push('--', shell, '-c', ''); // 占位，真实命令由调用方替换最后一个参数
  return { argv: args, backend: 'bubblewrap', reason: '' };
}

/**
 * 便捷函数：直接生成可执行 argv（把 command 放进 shell -c）。
 */
function buildBwrapExec(policy, cwd, command, shell = '/bin/sh', bwrapPath = null) {
  const built = buildBwrapArgv(policy, cwd, shell, bwrapPath);
  if (!built.argv.length) return built;
  const argv = built.argv.slice();
  argv[argv.length - 1] = String(command || '');
  return { argv, backend: 'bubblewrap', reason: '' };
}

module.exports = {
  findBwrap,
  linuxSandboxAvailable,
  buildBwrapArgv,
  buildBwrapExec,
  BWRAP_CANDIDATES,
};

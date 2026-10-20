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
const { spawnSync } = require('child_process');

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

// ── 可用性诊断（D-09-A）───────────────────────────────────────────────────────
// 事故形态：调用方只能拿到 true/false，于是「不是 Linux」「bwrap 没装」「装了但用不了」
// 三种完全不同的情况对用户呈现为同一句笼统失败。用户不知道该 apt install、该去宿主
// 开 userns、还是根本不该在这台机器上找 bubblewrap。这里把三态拆开并各配一条可执行建议。
//
// reason 是**互斥枚举**（四值全覆盖，无第五种可能）：
//   not-linux     当前平台不是 Linux —— 不该装 bwrap，应走各平台自己的后端
//   bwrap-missing 平台是 Linux 但找不到 bwrap 二进制 —— 该装包
//   bwrap-broken  二进制在、能跑 --version，但**建不出隔离命名空间** —— 该改内核/容器配置
//   ok            两项探测都通过 —— 真的可用
//
// ⚠️「bwrap 存在」≠「bwrap 可用」是本诊断存在的全部理由：容器（Docker 默认配置）
//    常禁用非特权 user namespace，AppArmor（Ubuntu 23.10+）也会拦 bwrap。这两种情况下
//    `bwrap --version` 照样成功，只有真正试着 unshare 一次才暴露。故 broken 的判定必须
//    跑一次 `--unshare-all --dev-bind / / true`，不能只看 --version。
const SANDBOX_STATUS_REASONS = Object.freeze(['not-linux', 'bwrap-missing', 'bwrap-broken', 'ok']);

// 探测超时：bwrap 正常毫秒级返回；卡住说明内核/AppArmor/hook 层出问题，10s 足够定性。
// 必须有超时——否则一个卡死的 bwrap 会把同步调用方（诊断页）一起拖死。
const PROBE_TIMEOUT_MS = 10000;

// 隔离探测用的最小参数：unshare 全部命名空间 + dev-bind 根 + 跑 true。
// 它同时验证四件事：能建非特权 userns、能 mount、能建 dev 节点、能 exec 子进程。
function describeProbeFailure(r) {
  if (r.error && r.error.code === 'ENOENT') return '二进制不存在或解释器缺失（ENOENT）';
  if (r.error && r.error.code === 'EACCES') return '二进制无执行权限（EACCES）';
  if (r.error && r.error.code === 'ENOEXEC') return '不是可执行格式（ENOEXEC，可能装成了脚本残片）';
  if (r.timedOut) return `${r.timeoutMs}ms 内未返回（超时强杀，疑似内核/AppArmor/hook 层卡住）`;
  if (r.signal) return `被信号 ${r.signal} 终止`;
  const err = String(r.stderr || '').trim();
  if (err) return `退出码 ${r.status}：${err.split('\n').slice(-3).join(' / ').slice(0, 600)}`;
  return `退出码 ${r.status}，无 stderr 输出`;
}

function probeBwrap(bwrapPath, args, timeoutMs) {
  let r;
  try {
    r = spawnSync(bwrapPath, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (e) {
    // spawnSync 通常不抛（错误放在 r.error 里），但参数非法等仍可能抛，一律按失败处理
    return { ok: false, status: null, signal: null, timedOut: false, stdout: '', stderr: '', error: e, timeoutMs };
  }
  return {
    // 判定只看「无 spawn 错误 且 退出码 0」；被信号杀掉时 status 为 null，必判失败
    ok: !r.error && r.status === 0,
    status: r.status,
    signal: r.signal || null,
    timedOut: !!(r.error && r.error.code === 'ETIMEDOUT'),
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    error: r.error || null,
    timeoutMs,
  };
}

/**
 * Linux OS 级沙箱（bubblewrap）可用性诊断。**返回诊断而非布尔**，让调用方能告诉用户该修什么。
 *
 * @param {object} [opts]
 * @param {string} [opts.platform]  覆盖 platform 判定（测试注入）
 * @param {Function} [opts.findBwrap] 覆盖二进制查找（测试注入；返回 null 可模拟未安装）
 * @param {boolean} [opts.probe=true] false = 只做静态判定（平台 + 二进制存在），不跑子进程
 * @param {number} [opts.timeoutMs]
 * @returns {{available: boolean, reason: string, detail: string, hint: string}}
 */
function linuxSandboxStatus(opts = {}) {
  const platform = opts.platform || process.platform;
  const probe = opts.probe !== false;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : PROBE_TIMEOUT_MS;
  const finder = typeof opts.findBwrap === 'function' ? opts.findBwrap : findBwrap;

  if (platform !== 'linux') {
    return {
      available: false,
      reason: 'not-linux',
      detail: `当前平台为 ${platform}，bubblewrap 是 Linux 专用后端，在任何其它平台都不会也不应可用`,
      hint: `不用装 bubblewrap。${platform} 请走各自后端：macOS 用 seatbelt（/usr/bin/sandbox-exec），`
        + 'Windows 用受限专用用户 + ACL + 防火墙（需先执行一次性管理员设置）。'
        + '想确认当前实际后端，调用 sandbox.js 的 detectBackend() 或 describeCapability()。',
    };
  }

  const bwrap = finder();
  if (!bwrap) {
    return {
      available: false,
      reason: 'bwrap-missing',
      detail: `已确认平台为 linux，但在 ${BWRAP_CANDIDATES.join(' / ')} 及 PATH 各项目录下均未找到 bwrap 二进制`,
      hint: '请安装 bubblewrap（按你的发行版选一条）：'
        + 'Ubuntu/Debian → sudo apt install bubblewrap；'
        + 'Fedora/RHEL → sudo dnf install bubblewrap；'
        + 'Arch → sudo pacman -S bubblewrap；'
        + 'Alpine → sudo apk add bubblewrap。'
        + '装完先 bwrap --version 确认，再跑 bwrap --unshare-all --dev-bind / / true 验证真的能隔离（两条都过才算可用）。',
    };
  }

  // 静态判定到此为止（linuxSandboxAvailable 用这个口径，保持历史语义与零子进程开销）
  if (!probe) {
    return {
      available: true,
      reason: 'ok',
      detail: `已确认平台为 linux 且找到 bwrap：${bwrap}（静态判定：未做运行时隔离探测）`,
      hint: '无需处理（静态口径）。要确认真正可用，调用 linuxSandboxStatus() 默认参数跑运行时探测。',
    };
  }

  // 第一关：二进制自身能跑（排除残缺安装 / 无执行位 / 架构不匹配）
  const ver = probeBwrap(bwrap, ['--version'], timeoutMs);
  if (!ver.ok) {
    return {
      available: false,
      reason: 'bwrap-broken',
      detail: `${bwrap} 文件存在，但执行 --version 失败（${describeProbeFailure(ver)}）—— 安装不完整或二进制不可执行`,
      hint: `先重装 bubblewrap 修好二进制本体（Ubuntu/Debian: sudo apt install --reinstall bubblewrap；`
        + 'Fedora: sudo dnf reinstall bubblewrap）。装完确认权限：ls -l $(command -v bwrap) 应含执行位。'
        + '若仍失败说明该二进制与当前内核/架构不匹配，请用发行版仓库版本而非自编译版本。',
    };
  }

  // 第二关：真的能建隔离命名空间。这是 --version 查不出来的一关，也是 broken 的主要来源。
  const isolation = probeBwrap(bwrap, ['--unshare-all', '--dev-bind', '/', '/', 'true'], timeoutMs);
  if (!isolation.ok) {
    const versionText = String(ver.stdout || '').trim().split('\n')[0] || '（--version 无输出）';
    return {
      available: false,
      reason: 'bwrap-broken',
      detail: `${bwrap} 可执行（${versionText}），但隔离探测「--unshare-all --dev-bind / / true」失败：`
        + describeProbeFailure(isolation),
      hint: 'bwrap 装好了但当前环境不允许它建命名空间，按顺序排查并执行对应命令：'
        + '① 非特权 user namespace 是否开启：cat /proc/sys/kernel/unprivileged_userns_clone（Debian/Ubuntu 应为 1，'
        + '为 0 则 sudo sysctl -w kernel.unprivileged_userns_clone=1）；cat /proc/sys/user/max_user_namespaces（应 > 0）；'
        + '② Ubuntu 23.10+ 的 AppArmor 限制：sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0，'
        + '并用 sudo aa-status 确认没有 profile 拦 bwrap；'
        + '③ 容器/Docker 内：容器需 --security-opt seccomp=unconfined（或等价放开 userns 的 profile），'
        + '且宿主机本身不能禁用 userns；'
        + '④ setuid 位被裁剪：ls -l $(command -v bwrap) 正常应为 -rwsr-xr-x。'
        + '以上都改不了时，沙箱会降级到 exec.js 的命令守卫（30 条危险模式硬拦截仍生效），'
        + '但那是命令级拦截、不是 OS 级隔离，隔离强度实际下降。',
    };
  }

  const versionText = String(ver.stdout || '').trim().split('\n')[0] || 'bubblewrap';
  return {
    available: true,
    reason: 'ok',
    detail: `${bwrap} 可用（${versionText}），隔离探测「--unshare-all --dev-bind / / true」通过`,
    hint: '无需处理。可随时用 bwrap --unshare-all --dev-bind / / true 复验隔离能力。',
  };
}

// 可用性（历史口径，**行为保持不变**）：只看「平台 + 二进制存在」，**不做运行时探测**。
//
// 为什么不直接返回 linuxSandboxStatus().available：本函数是同步热路径
// （sandbox.js:210 detectBackend ← osSandboxUsable ← 每次 exec 判定），在那里起子进程
// 会让每次执行都多两次 fork+exec。而运行时失败本来就由 exec 的错误路径捕获并降级。
// 因此这里显式走 probe:false 的静态口径，把「真可用吗」留给 linuxSandboxStatus()。
// 该口径同时被 test/sandbox-crossplatform.test.js:44 与 test/sandbox-linux.test.mjs:131 钉死。
function linuxSandboxAvailable() {
  return linuxSandboxStatus({ probe: false }).available;
}

/**
 * 构建 bwrap 启动参数（纯函数，可单测）。
 * @param {string} policy  read-only | workspace-write | full-access
 * @param {string} cwd     项目目录（workspace-write 时作为唯一可写区）
 * @param {string} shell   shell 路径，默认 /bin/sh
 * @param {string|null} bwrapPath  显式指定 bwrap 路径（测试注入用；null 则自动探测）
 * @returns {{argv: string[], backend: string, reason: string}}
 */
function buildBwrapArgv(policy, cwd, shell = '/bin/sh', bwrapPath = null, protectedPaths = []) {
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
    // P0 修复（2026-10-16）：删除 '--seccomp', '9'。
    // 事故：libuv 在 exec 前关闭所有非 stdio fd，子进程只有 fd 0/1/2 ⇒ fd 9 根本不存在，
    // bwrap 启动即失败。而 exec.js 用 execFile 执行（不声明 stdio），也无法补上该 fd。
    // 已实测：对 'a' 之外的写-only 模式 fd 调 readSync 抛 EBADF；唯一可行路径是
    // spawn + 显式 stdio[9]=fd，但那条改动影响面大且需真机验证。
    // 现依赖 bwrap 的 --unshare-all + 只读 bind 已提供的命名空间级隔离；
    // seccomp 系统调用过滤作为**后续增量**，待 fd 传递打通后再加（届时必须走 spawn）。
    // 不继承宿主环境里的敏感变量由调用方处理（shellEnv）
  ];

  const safeCwd = String(cwd || '');
  if (policy === 'workspace-write') {
    if (!safeCwd) {
      return { argv: [], backend: 'bubblewrap', reason: 'workspace-write 需要项目目录' };
    }
    // 唯一可写区：项目目录（读写 bind 覆盖上面的只读挂载）
    args.push('--bind', safeCwd, safeCwd);
    // 可写区内的只读 carve-out（对齐 Codex 当前 Linux 沙箱架构）：
    // 项目目录整体可写会连带把 `.git` 变成可写——改写 .git/hooks/pre-commit 后，
    // 用户下次手动 git commit 即执行注入代码（沙箱只约束 Agent 进程，约束不了用户后续的手动命令）。
    // bwrap 后挂载覆盖先挂载，因此在 `--bind` 之后对这些路径再 `--ro-bind` 一次即为只读。
    for (const p of protectedPaths) {
      const sp = String(p || '');
      if (!sp) continue;
      args.push('--ro-bind', sp, sp);
    }
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
function buildBwrapExec(policy, cwd, command, shell = '/bin/sh', bwrapPath = null, protectedPaths = []) {
  const built = buildBwrapArgv(policy, cwd, shell, bwrapPath, protectedPaths);
  if (!built.argv.length) return built;
  const argv = built.argv.slice();
  argv[argv.length - 1] = String(command || '');
  return { argv, backend: 'bubblewrap', reason: '' };
}

module.exports = {
  findBwrap,
  linuxSandboxAvailable,
  linuxSandboxStatus,
  SANDBOX_STATUS_REASONS,
  buildBwrapArgv,
  buildBwrapExec,
  BWRAP_CANDIDATES,
};

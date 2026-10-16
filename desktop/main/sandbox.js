// macOS Seatbelt 沙箱：profile 生成（纯函数，可单测）+ 可用性探测 + 跨平台兜底守卫
//
// 2026-10 对齐 OpenAI Codex 的 macOS 方案后的两处加固：
//   ① read-only 档不再依赖 `(allow file-read*)` 的宽放语义，而是显式补一份
//      「macOS 平台策略」——放行 shell/git/node 等工具运行时必需的framework 与
//      系统配置路径，而不是宽放整个 /System。Codex 的做法同样如此
//      （"appends a curated macOS platform policy instead of broadly allowing /System"）。
//      宽放 /System 会让恶意命令读到本不该读的系统内部状态，收紧后仍需保证工具链可用。
//   ② 支持 denial 日志（等价于 Codex 的 --log-denials）：profile 末尾追加
//      `(deny file-write* (with no-log))` 的反向声明，使被拒操作可在系统日志追溯，
//      便于用户排查「为什么某命令在沙箱里失败」。
const fs = require('fs');

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

// macOS 平台策略：工具链运行时必需的只读路径（收紧 /System 后的补偿）
// 只放行「执行与配置读取」所需，不放行 /System 全树。
// 注：曾尝试追加 `(deny file-write* (with no-log))` 以实现等价 Codex --log-denials 的
// 被拒审计，但该修饰符的合法性无法在本开发环境验证（此环境 sandbox-exec 被外层沙箱
// 拦截，三种 profile 变体均无法实际 apply）。不能把未验证的语法上线，故移除该特性；
// 需要时可另行验证后再加回。
const MACOS_PLATFORM_POLICY = [
  '(allow file-read* (subpath "/System/Library") (subpath "/usr/lib") (subpath "/usr/share"))',
  '(allow file-read* (subpath "/private/etc") (subpath "/etc"))',
  '(allow file-read* (literal "/usr/bin/env") (literal "/bin/sh") (literal "/bin/zsh"))',
  '(allow file-read* (subpath "/Library/Apple") (subpath "/Library/Preferences"))',
  '(allow mach-lookup (global-name "com.apple.system.logger"))',
  '(allow sysctl-read)',
  '(allow process-exec (subpath "/usr/bin") (subpath "/bin") (subpath "/usr/sbin") (subpath "/sbin"))',
  '(allow process-fork)',
];

// P0-S1：跨平台兜底守卫的危险命令规则改为与审批层**同源**（来自 dangerousPatterns.js）。
// 事故背景：此前这里是 12 条、approval.js 是 10 条，两份手抄副本各自漂移，
// 导致「审批层比沙箱层宽松」——两层守卫同时被绕过。现在两层共用同一份规则集，
// 从结构上杜绝再次漂移（新增危险模式只需改dangerousPatterns.js 一处）。
const { DANGEROUS_PATTERNS } = require('./dangerousPatterns');
// 保留旧名导出，避免外部引用断裂（测试与main.js 均按此名引用）
const FALLBACK_DANGEROUS = DANGEROUS_PATTERNS;

// 三平台全量接通 OS 级沙箱后（2026-10），兜底守卫的判定必须按「当前平台真正的后端」
// 走，而不是写死 darwin：
//   · darwin  → sandbox-exec 是否存在
//   · linux   → bwrap 二进制是否存在（findBwrap 是跨平台纯探测，非 linux 上返回 null）
//   · win32   → 就绪态是异步的（net user 查询），同步无法判定 → 保守按不可用，守卫生效
// 这样做的原因：OS 级沙箱已把破坏面限制在项目目录内，此时再叠黑名单会误伤
// 「rm -rf ./build」这类项目内合理命令；反过来，没有 OS 沙箱时必须靠黑名单兜底。
// 第 5 参 backendAvail 允许调用方传入**已确认**的可用性（如 Windows 异步探测结果），
// 传入时不再走推断。
function defaultOsSandboxAvailable(platform, execExists) {
  if (platform === 'darwin') return !!execExists;
  if (platform === 'linux') return !!linuxBackend.findBwrap();
  return false;
}

// 拦截文案里的平台专属修复提示：用户被拦时最需要的是「下一步怎么做」
const OS_SANDBOX_HINT = {
  linux: '（安装 bubblewrap 后自动获得同级 OS 级隔离：apt install bubblewrap / dnf install bubblewrap）',
  win32: '（完成一次性管理员设置后自动获得同级 OS 级隔离，见 README「安全模型与沙箱能力分档」）',
};

// 返回 { blocked: boolean, reason: string }
function checkCommandGuard(policy, command, platform = process.platform, execExists = true, backendAvail) {
  if (!policy || policy === 'full-access') return { blocked: false, reason: '' }; // 显式 full-access 是 opt-in，不拦
  const osSandbox = backendAvail === undefined
    ? defaultOsSandboxAvailable(platform, execExists)
    : !!backendAvail;
  if (osSandbox) return { blocked: false, reason: '' }; // 有 OS 级沙箱，无需名单兜底
  const cmd = String(command || '');
  const hit = FALLBACK_DANGEROUS.find((p) => p.test(cmd));
  if (hit) {
    const hint = OS_SANDBOX_HINT[platform] || '';
    return { blocked: true, reason: `当前系统无 OS 级沙箱${hint}，已按安全策略拦截危险命令：${cmd.slice(0, 120)}` };
  }
  return { blocked: false, reason: '' };
}

// 依据沙箱策略与项目目录生成 Seatbelt profile
// read-only: 只读 + 禁网；workspace-write: 项目目录与临时目录可写 + 禁网；full-access: 不沙箱
// 真机复盘（打包版）：zsh 等标准 shell 大量使用 `>/dev/null` 重定向（如 `cmd 2>/dev/null`），
// profile 未放行 /dev/null 写入 → 「operation not permitted: /dev/null」，模型被迫换写法浪费轮次。
// /dev/null 是字面黑洞设备，放行写入无任何数据外泄风险，两个档位统一 allow。
function buildSeatbeltProfile(policy, cwd, protectedPaths = []) {
  const tmpPaths = ['/private/tmp', '/private/var/tmp', '/tmp'];
  const tmpRules = tmpPaths.map((p) => `(subpath "${p}")`).join(' ');
  const tail = [
    // /dev/null 是字面黑洞设备，放行写入无任何数据外泄风险，两个档位统一 allow。
    // 注意顺序：Seatbelt 后匹配规则优先生效，故 /dev/null 的 allow 必须跟在 deny 之后。
    '(allow file-write* (literal "/dev/null"))',
    '(deny network*)',
  ];
  if (policy === 'read-only') {
    return [
      '(version 1)',
      '(deny default)',
      // 收紧：不再宽放 file-read* 全树，改用平台策略显式放行工具链所需路径
      ...MACOS_PLATFORM_POLICY,
      // 项目目录与家目录仍可读（读代码是 read-only 档的核心用途）
      cwd ? `(allow file-read* (subpath "${String(cwd).replace(/"/g, '\\"')}"))` : '',
      '(allow file-read* (subpath "/Users") (subpath "/private/var/folders"))',
      // 显式 deny file-write*：deny default 已隐含拒绝，此处显式声明是防御性冗余，
      // 也让「只读档」的意图在 profile 里自解释（测试亦断言该行存在）
      '(deny file-write*)',
      ...tail,
    ].filter(Boolean).join('\n');
  }
  const safeCwd = String(cwd || '').replace(/"/g, '\\"');
  const writeRule = safeCwd
    ? `(allow file-write* (subpath "${safeCwd}") ${tmpRules})`
    : `(allow file-write* ${tmpRules})`;
  // 可写区内的只读 carve-out（对齐 Codex 的 .git / 自身配置目录保护）：
  // Seatbelt 后匹配规则优先生效，故对本行之后的路径追加 deny 即可压住上面的 file-write* allow。
  // 动机同 Linux 侧：项目目录整体可写会把 `.git` 变得可写，而改写 .git/hooks/pre-commit
  // 会让用户下次手动 git commit 执行注入代码——沙箱约束不了用户之后的手动命令。
  const protectedDeny = protectedPaths.length
    ? `(deny file-write* ${protectedPaths
      .map((p) => `(subpath "${String(p).replace(/"/g, '\\"')}")`)
      .join(' ')})`
    : '';
  return [
    '(version 1)',
    '(deny default)',
    // workspace-write 档保留宽放 file-read*：Agent 需要读全盘才能定位依赖与配置，
    // 收紧读取面会直接破坏可用性（Codex 在该档同样读全盘、只限写）。
    ...MACOS_PLATFORM_POLICY,
    writeRule,
    protectedDeny,
    ...tail,
  ].filter(Boolean).join('\n');
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

// N3（2026-10-16）：Seatbelt **真实可用性**探测——「sandbox-exec 存在」≠「能 apply」。
// 真因取证（本机二分复现）：在自身已处于 OS 沙箱内的进程（如被其他 Agent 平台沙箱包住的
// 开发/审查环境）中，任何嵌套 sandbox_apply 都报 `sandbox_apply: Operation not permitted`
//（macOS 不允许嵌套沙箱）；而「无实际限制」的 profile 会被短路成功，造成看似可用的假象。
// 探测用一个带真实 deny 的最小 profile：成功 = 真实可用；Operation not permitted = 嵌套沙箱环境
//（诚实上报，让调用方走 V03 的统一兜底而非运行时报晦涩错误）。
let seatbeltProbe = null; // 进程级缓存：能力不随运行变化
function resetSeatbeltProbe() { seatbeltProbe = null; }
async function seatbeltUsable() {
  if (seatbeltProbe) return seatbeltProbe;
  if (process.platform !== 'darwin') {
    seatbeltProbe = { ok: false, reason: '非 darwin 平台' };
    return seatbeltProbe;
  }
  if (!sandboxAvailable()) {
    seatbeltProbe = { ok: false, reason: 'sandbox-exec 不存在' };
    return seatbeltProbe;
  }
  try {
    await new Promise((resolve, reject) => {
      const { execFile } = require('child_process');
      execFile(SANDBOX_EXEC,
        ['-p', '(version 1)(deny default)(allow default)(deny network*)', '/bin/echo', 'mjcode-probe'],
        { timeout: 8000 },
        (err) => (err ? reject(err) : resolve()));
    });
    seatbeltProbe = { ok: true, reason: '' };
  } catch (e) {
    const msg = String(e?.message || e);
    seatbeltProbe = /Operation not permitted/i.test(msg)
      ? { ok: false, reason: '当前进程自身已处于 OS 沙箱内（macOS 不允许嵌套沙箱）：Seatbelt 隔离无法生效，MJCode 不应在其他 Agent 平台的沙箱环境中运行' }
      : { ok: false, reason: `sandbox-exec 探测失败：${msg.slice(0, 160)}` };
  }
  return seatbeltProbe;
}

// 决策：本次 shell 是否应包沙箱
function shouldSandbox(policy, cwd) {
  if (!policy || policy === 'full-access') return { use: false, reason: 'full-access' };
  if (!sandboxAvailable()) return { use: false, reason: 'sandbox-exec 不可用' };
  if (policy === 'workspace-write' && !cwd) return { use: false, reason: 'workspace-write 需要项目目录' };
  return { use: true };
}

// ── 三平台 OS 级沙箱统一分发（2026-10 新增）────────────────────────────
// 目标：macOS / Linux / Windows 都有 OS 级隔离，不再只有 macOS 有。
// 方案对齐 OpenAI Codex（见各后端文件顶部注释）：
//   macOS   → Seatbelt（sandbox-exec + 生成 profile）
//   Linux   → bubblewrap（ro-bind + unshare-all + seccomp）
//   Windows → 受限专用用户 + ACL + 防火墙（opt-in 管理员设置；Codex 明确否决 AppContainer）
//
// 统一契约：detectBackend() 返回当前可用的后端标识；
//           buildExec() 返回 { use, argv, reason, backend }，use=false 时由调用方
//           落到 checkCommandGuard 的命令级兜底。
const linuxBackend = require('./sandboxLinux');
const windowsBackend = require('./sandboxWindows');

/**
 * 探测当前平台可用的 OS 级沙箱后端。
 * @returns {{backend: 'seatbelt'|'bubblewrap'|'windows-restricted-user'|'none', reason: string}}
 */
function detectBackend() {
  if (process.platform === 'darwin') {
    return sandboxAvailable()
      ? { backend: 'seatbelt', reason: '' }
      : { backend: 'none', reason: 'sandbox-exec 不可用' };
  }
  if (process.platform === 'linux') {
    return linuxBackend.linuxSandboxAvailable()
      ? { backend: 'bubblewrap', reason: '' }
      : { backend: 'none', reason: 'bwrap 未安装（Ubuntu/Debian: apt install bubblewrap）' };
  }
  if (process.platform === 'win32') {
    // Windows 后端需一次性管理员设置；此处只做静态提示，运行时由 windowsSandboxReady() 异步确认
    return { backend: 'windows-restricted-user', reason: '需先执行一次性管理员设置（windowsSandboxPlan）' };
  }
  return { backend: 'none', reason: `未支持的平台：${process.platform}` };
}

/**
 * 统一的「本次是否可 OS 级沙箱」判定（同步部分；Windows 的就绪态需异步另行确认）。
 */
function osSandboxUsable(policy, cwd) {
  if (!policy || policy === 'full-access') return { use: false, reason: 'full-access' };
  const b = detectBackend();
  if (b.backend === 'none') return { use: false, reason: b.reason };
  if (policy === 'workspace-write' && !cwd) return { use: false, reason: 'workspace-write 需要项目目录' };
  return { use: true, backend: b.backend };
}

// N3 四合一（方案 §8.2 能力矩阵）：结构化能力描述——后端标识 / 真实可用性 / 原因 / 嵌套沙箱标记。
// 消费方：诊断页、UI 水位显示、运行时 gate（不再各自拼接碎片信息）。
async function describeCapability() {
  const b = detectBackend();
  if (b.backend === 'seatbelt') {
    const belt = await seatbeltUsable();
    return {
      backend: 'seatbelt',
      available: belt.ok,
      reason: belt.reason,
      nestedSandbox: /嵌套沙箱/.test(belt.reason),
    };
  }
  return { backend: b.backend, available: b.backend !== 'none', reason: b.reason, nestedSandbox: false };
}

module.exports = {
  buildSeatbeltProfile, sandboxAvailable, shouldSandbox, checkCommandGuard,
  FALLBACK_DANGEROUS, SANDBOX_EXEC,
  // 三平台分发（新增）
  detectBackend, osSandboxUsable,
  // N3：Seatbelt 真实可用性探测（嵌套沙箱环境诚实上报）
  seatbeltUsable, resetSeatbeltProbe, describeCapability,
  linuxBackend, windowsBackend,
};

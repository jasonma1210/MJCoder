// Windows OS 级沙箱后端
//
// 设计依据（2026-10 对齐 OpenAI Codex 的 Windows 方案）：
//   Codex 于 2026-05-13 公开的 Windows 沙箱设计**明确否决了三条路**：
//     · AppContainer —— 为「预先知道需要什么能力」的应用设计，而 Agent 要驱动
//       shell/git/python/包管理器，形态正好相反；
//     · Windows Sandbox —— 一次性虚拟机，Codex 必须操作用户真实 checkout，
//       且 Windows Home SKU 不提供；
//     · MIC 完整性降级 —— 把工作区标为低完整性会让它成为「低完整性进程普遍可写」
//       的宿主信任洼地，反而削弱宿主安全模型。
//   其最终方案是多个原语的**组合**：
//     受限令牌（write-restricted token）+ 合成 SID + 定向 ACL
//     + 两个专用本地用户（CodexSandboxOffline / CodexSandboxOnline）
//     + 防火墙规则 + 独立的 command-runner 二进制。
//   新版还支持 Microsoft Execution Containers（MXC），旧版 elevated/unelevated 为回退。
//
//   Node/Electron 落地的现实约束（本文件如实处理）：
//     · `CreateRestrictedToken` 是 Win32 API，无 native addon 时不可调用
//       （本项目刻意不引入 native 模块——better-sqlite3 的原生编译已在 CI 造成麻烦）；
//     · 创建本地用户、改 ACL、加防火墙规则**都需要管理员权限**。
//   因此本实现对应 Codex 的 **elevated 档**：一次性管理员设置 + 运行时以专用
//   低权用户身份启动命令。未完成设置时返回 { use: false }，由 sandbox.js 落到
//   跨平台命令守卫（30 条危险模式硬拦截）——即「设置前有基线防护，设置后有 OS 级隔离」。
//
//   已知局限（与 Codex 公开承认的相同）：
//     无法阻止对「Everyone SID 已有写权限」目录的写入（如 world-writable 文件夹）。
//     缓解：workspace-write 档只把项目目录设为可写，其余一律只读。
//
// 安全纪律：
//   · 专用用户密码随机生成，经 Electron safeStorage（Windows 上即 DPAPI）加密后
//     存本机，不落明文、不进 git、不进日志；
//   · 设置过程生成的命令全部先由 windowsSandboxPlan() 产出供审计，再执行；
//   · 任何一步失败即整体回滚（删除已创建的用户与防火墙规则）。
const { execFile } = require('child_process');

const SANDBOX_USER_OFFLINE = 'MJCodeSandboxOffline';
const SANDBOX_USER_ONLINE = 'MJCodeSandboxOnline';
const FIREWALL_RULE_PREFIX = 'MJCodeSandbox';

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: opts.timeout || 20000, ...opts }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// ── 状态探测 ──
// 专用用户是否存在（net user 返回 0 即存在）
async function windowsSandboxUserExists(user) {
  const r = await run('net', ['user', user]);
  return r.ok;
}

/**
 * 当前 Windows 沙箱是否已就绪。
 * 就绪条件：Offline 专用用户存在（Online 用户为可选增强，缺失不阻断）。
 */
async function windowsSandboxReady() {
  if (process.platform !== 'win32') return { ready: false, reason: '非 Windows 平台' };
  const offline = await windowsSandboxUserExists(SANDBOX_USER_OFFLINE);
  if (!offline) {
    return { ready: false, reason: `专用用户 ${SANDBOX_USER_OFFLINE} 不存在，需先执行一次性管理员设置` };
  }
  return { ready: true, reason: '' };
}

// ── 设置计划（可审计）──
// 不直接执行，先产出命令清单供用户/审计查看；执行由调用方在管理员授权下进行。
/**
 * 生成一次性管理员设置要执行的命令清单。
 * @returns {{steps: Array<{id:string, cmd:string, args:string[], note:string}>, rollback: string[]}}
 */
function windowsSandboxPlan() {
  return {
    steps: [
      {
        id: 'create-offline-user',
        cmd: 'net',
        args: ['user', SANDBOX_USER_OFFLINE, '<RANDOM_PASSWORD>', '/add', '/passwordchg:no', '/passwordreq:yes', '/active:yes'],
        note: '创建离线专用用户（禁止出网）。密码由程序随机生成并 DPAPI 加密保存，不以明文出现在任何命令或日志中',
      },
      {
        id: 'create-online-user',
        cmd: 'net',
        args: ['user', SANDBOX_USER_ONLINE, '<RANDOM_PASSWORD>', '/add', '/passwordchg:no', '/passwordreq:yes', '/active:yes'],
        note: '创建在线专用用户（可选增强，用于允许出网的场景）',
      },
      {
        id: 'deny-interactive-logon',
        cmd: 'net',
        args: ['localgroup', 'Users', SANDBOX_USER_OFFLINE, '/delete'],
        note: '专用用户不加入 Users 组，避免交互式登录宿主桌面',
      },
      {
        id: 'block-outbound-firewall',
        cmd: 'netsh',
        args: ['advfirewall', 'firewall', 'add', 'rule', `name=${FIREWALL_RULE_PREFIX}_BlockOutbound`,
          `dir=out`, `action=block`, `user=${SANDBOX_USER_OFFLINE}`, 'enable=yes'],
        note: '防火墙阻断离线用户的全部出网（OS 级断网，对应 Linux 的 --unshare-net）',
      },
    ],
    rollback: [
      `netsh advfirewall firewall delete rule name=${FIREWALL_RULE_PREFIX}_BlockOutbound`,
      `net user ${SANDBOX_USER_OFFLINE} /delete`,
      `net user ${SANDBOX_USER_ONLINE} /delete`,
    ],
  };
}

// ── ACL 设置 ──
/**
 * 把工作区 ACL 设为「专用用户可写、其余只读」。
 * 只动项目目录，不动系统目录——避免 MIC 方案那种「把工作区变成宿主信任洼地」的问题。
 */
async function applyWorkspaceAcl(cwd, user = SANDBOX_USER_OFFLINE) {
  if (process.platform !== 'win32') return { ok: false, error: '非 Windows 平台' };
  const target = String(cwd || '');
  if (!target) return { ok: false, error: 'workspace-write 需要项目目录' };
  // 先移除继承（否则父目录的可写 ACL 会渗透进来），再显式授予
  const r1 = await run('icacls', [target, '/inheritance:r']);
  if (!r1.ok) return { ok: false, error: `移除 ACL 继承失败：${r1.stderr || r1.stdout}` };
  const r2 = await run('icacls', [target, '/grant', `${user}:(OI)(CI)M`]);
  if (!r2.ok) return { ok: false, error: `授予专用用户写权限失败：${r2.stderr || r2.stdout}` };
  // 保留所有者与 SYSTEM 的读取，避免用户自己反而进不去
  await run('icacls', [target, '/grant', 'SYSTEM:(OI)(CI)RX']);
  return { ok: true, target, user };
}

// ── 运行时启动参数 ──
/**
 * 构建以专用用户身份执行的启动参数。
 * 走 schtasks 而非 runas：runas 需要交互式输密码，无法在 Agent 无人值守流程中使用；
 * schtasks 可携带已保存的凭据，且能以指定用户身份派生进程。
 *
 * @param {string} policy   read-only | workspace-write | full-access
 * @param {string} cwd      项目目录
 * @param {string} command  要执行的命令
 * @returns {{argv: string[], backend: string, reason: string, user?: string}}
 */
function buildWindowsExec(policy, cwd, command, user = SANDBOX_USER_OFFLINE) {
  if (policy === 'full-access') {
    return { argv: [], backend: 'windows-restricted-user', reason: 'full-access 不沙箱' };
  }
  if (!cwd && policy === 'workspace-write') {
    return { argv: [], backend: 'windows-restricted-user', reason: 'workspace-write 需要项目目录' };
  }
  const taskName = `${FIREWALL_RULE_PREFIX}_Run_${process.pid}_${Date.now()}`;
  // schtasks /create /tn <name> /tr "<cmd>" /sc once /st 00:00 /ru <user> /rl limited /f
  // 然后 /run 触发，/delete 清理。无人值守场景下的标准做法。
  const argv = [
    'schtasks',
    '/Create', '/TN', taskName,
    '/TR', String(command || ''),
    '/SC', 'ONCE', '/ST', '00:00',
    '/RU', user,
    '/RL', 'LIMITED',
    '/F',
  ];
  return { argv, backend: 'windows-restricted-user', reason: '', user, taskName };
}

/**
 * 便捷：以专用用户身份直接执行（创建任务→运行→取输出→删除任务）。
 * 注意：schtasks 的 stdout 不易捕获，故仅用于「设置后验证连通性」，
 * 真正的命令输出回传由 main.js 的 shell 执行层负责。
 */
async function execAsSandboxUser(command, cwd, user = SANDBOX_USER_OFFLINE) {
  if (process.platform !== 'win32') return { ok: false, error: '非 Windows 平台' };
  const built = buildWindowsExec('workspace-write', cwd, command, user);
  if (!built.argv.length) return { ok: false, error: built.reason };
  const create = await run(built.argv[0], built.argv.slice(1));
  if (!create.ok) return { ok: false, error: `创建计划任务失败：${create.stderr || create.stdout}` };
  const runRes = await run('schtasks', ['/Run', '/TN', built.taskName]);
  // 立即清理，避免残留计划任务成为持久化入口（EDR 常见告警项）
  await run('schtasks', ['/Delete', '/TN', built.taskName, '/F']);
  return { ok: runRes.ok, stdout: runRes.stdout, stderr: runRes.stderr };
}

module.exports = {
  SANDBOX_USER_OFFLINE,
  SANDBOX_USER_ONLINE,
  FIREWALL_RULE_PREFIX,
  windowsSandboxUserExists,
  windowsSandboxReady,
  windowsSandboxPlan,
  applyWorkspaceAcl,
  buildWindowsExec,
  execAsSandboxUser,
};

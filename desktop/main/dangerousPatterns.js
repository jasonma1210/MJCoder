// 危险命令规则——全项目唯一事实来源（single source of truth）
//
// 为什么需要这个文件（P0-S1）：
//   此前 approval.js 的 DANGEROUS_PATTERNS（10 条）与 sandbox.js 的
//   FALLBACK_DANGEROUS（12 条）是两份手抄副本，approval.js 注释声称「保持同步」
//   但实际已漂移。漂移后果是**审批层比沙箱层宽松**：管道远程执行
//   （curl xxx | sh）与 rm 长选项（rm --recursive --force）能同时绕过两层守卫，
//   在默认 on-request 档下不弹任何审批直接执行。
//
// 规则：任何需要「识别危险 shell 命令」的地方，一律从这里取，禁止再手写副本。
// 本文件零依赖（纯常量 + 正则），可被主进程、审批层、沙箱层与测试共同 import。

// ── L1 危险命令模式 ──
//
// 两条设计原则：
//   1) **宁可误报不可漏报**——危险命令多弹一次审批的成本，远低于漏判的代价。
//   2) **覆盖等价写法**——短选项/长选项、单双引号、参数顺序变体都要覆盖。
const DANGEROUS_PATTERNS = [
  // ── 文件删除 ──
  // 覆盖：rm -rf / rm -fr / rm --recursive --force / rm -r -f / rm -Rf
  // 注意不能只写 /\brm\s+-[rf]/：长选项（--recursive --force）与分离参数
  // （rm -r -f）都匹配不到，会被绕过。
  /\brm\b[^|;&]*\s-[a-zA-Z]*[rf]/,
  /\brm\b[^|;&]*--recursive\b/,
  /\brm\b[^|;&]*--force\b/,

  // ── 提权 ──
  /\bsudo\b/,
  /\bsu\b\s+-/, // su - / su root

  // ── 磁盘与文件系统破坏 ──
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+if=/,
  /\bdiskutil\s+(erase|partition|format)/i,
  /\bchmod\s+(-[a-zA-Z]+\s+)*777\b/,
  /\bchown\s+(-[a-zA-Z]+\s+)*root\b/,

  // ── Git 破坏性操作 ──
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[fd]/,
  /\bgit\s+branch\s+(-[a-zA-Z]+\s+)*-D\b/,

  // ── 系统关机/重启（注意 reboot/shutdown 是 shutdown 的子串，用 \b 包裹避免误判）──
  /\bshutdown\b/,
  /\breboot\b/,
  /\bhalt\b/,
  /\bpoweroff\b/,
  /\bkill\s+-9\s+1\b/, // init 进程
  /\bkillall5\b/,

  // ── fork 炸弹 ──
  /:\(\)\{/,
  /:\(\)\{.*\};\s*:/,

  // ── 管道执行远程脚本（本次 P0 漏洞的核心）──
  // 覆盖 curl|sh、wget|bash、fetch|sh、以及带 -s -L -o 等参数组合的变体。
  // 「管道左侧」允许任意字符（含引号），只要求右侧是解释器并被管道连接。
  /\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(ba|z|k|fi|da)?sh\b/,
  /\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(python[0-9.]*|perl|ruby|node)\b/,
  // 形如 | sh 这类「左侧命令被省略」的极简写法
  /(^|[^a-zA-Z0-9])\|\s*(sudo\s+)?(ba|z|k)?sh\b/,

  // ── 远程代码执行：base64 解码后执行 ──
  /\bbase64\s+(-d|--decode)[^|]*\|\s*(ba|z)?sh\b/,

  // ── 历史与凭证外泄 ──
  /\bhistory\s+-c\b/,
  /\bcat\s+[^|;&]*(\.ssh\/id_|\.aws\/credentials|\.env\b|\.npmrc)/,

  // ── 包管理器全局卸载（误伤面大，保留但放在末尾）──
  /\bnpm\s+(uninstall|rm)\s+-g\b/,
  /\bbrew\s+uninstall\b/,

  // ── Windows / PowerShell / cmd 等价物（P0 补齐，2026-10-16）──
  // 缺口实证：此前 30 条规则**全是 POSIX 语义**。Windows 上
  //   Remove-Item -Recurse -Force / rmdir /s /q / del /f /q / format 一条未覆盖；
  //   Invoke-Expression / iex / DownloadString（等价 curl|sh）一条未覆盖。
  // 叠加「Windows 沙箱需一次性管理员设置、默认不启用」这一事实，
  // Windows 用户当时**既无 OS 级沙箱、又无有效黑名单** ⇒ 危险命令防护实际为零。
  // 设计原则同上：宁可误报不可漏报，覆盖别名与参数缩写。

  // 递归删除：Remove-Item / ri / rd / rm / del（PowerShell 别名与 POSIX 同名）
  /\b(Remove-Item|ri|rd|rm|del)\b[^|;&]*(\s-[a-zA-Z]*[rR]|-Recurse\b)/,
  /\b(Remove-Item|ri|rd|rm|del)\b[^|;&]*(-Force|-fo\b|-Confirm\s*:\s*\$false)/i,

  // cmd 删除：rmdir /s /q、rd /s /q、del /f /q /s、erase /f
  /\b(rmdir|rd|del|erase)\b[^|;&]*\/s\b/i,
  /\b(rmdir|rd|del|erase)\b[^|;&]*\/q\b/i,
  /\b(rmdir|rd|del|erase)\b[^|;&]*\/f\b/i,

  // 磁盘与卷破坏（等价 mkfs / dd if= / diskutil erase）
  /\bformat\s+[a-zA-Z]:/i,
  /\bdiskpart\b/i,
  /\b(Clear-Disk|Initialize-Disk|Remove-Partition|Remove-Volume)\b/i,
  /\bcipher\s+\/w\b/i,

  // 动态执行（等价 curl xxx | sh）：Invoke-Expression 与调用运算符 &()
  /\b(Invoke-Expression|iex)\b/i,
  /&\s*\(/,

  // 远程下载后执行（等价 curl/wget 取脚本再跑）
  /\b(DownloadString|DownloadFile|DownloadData)\b/i,
  /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i,
  /\bStart-BitsTransfer\b/i,
  /\bNet\.WebClient\b/i,

  // 编码混淆执行（等价 base64 -d | sh）
  /-EncodedCommand\b/i,
  /\s-enc(odedcommand)?\s+[A-Za-z0-9+/]{40,}/i,
  /\[\s*Convert\s*\]\s*::\s*FromBase64String/i,

  // 提权（等价 sudo）：Start-Process -Verb RunAs / runas
  /\bStart-Process\b[^|;&]*-Verb\s+RunAs/i,
  /\brunas\b/i,

  // 系统控制与强制终止
  /\b(Stop-Computer|Restart-Computer)\b/i,
  /\btaskkill\b[^|;&]*\/f\b/i,
  /\bStop-Process\b[^|;&]*-Force\b/i,

  // 凭证与历史外泄
  /\bGet-Content\b[^|;&]*(\.ssh\\|\.aws\\|\.env\b|\.npmrc|\.git-credentials)/i,
  /\bcmdkey\b/i,

  // 防护篡改 / 持久化入口 / ACL 篡改
  /\bSet-ExecutionPolicy\b[^|;&]*(Unrestricted|Bypass)/i,
  /\bsc(\.exe)?\s+create\b/i,
  /\b(New-ScheduledTask|Register-ScheduledTask)\b/i,
  /\bschtasks\b[^|;&]*\/create\b/i,
  /\bicacls\b[^|;&]*\/grant\b/i,
  /\btakeown\b/i,
];

// ── 判定工具 ──

/**
 * 判断一条 shell 命令是否命中危险模式。
 * @param {string} command 待判定命令
 * @returns {boolean}
 */
function isDangerousCommand(command) {
  const cmd = String(command || '');
  if (!cmd.trim()) return false;
  return DANGEROUS_PATTERNS.some((p) => p.test(cmd));
}

/**
 * 返回命中的第一条规则（用于给用户解释「为什么被拦」）。
 * @param {string} command
 * @returns {RegExp|null}
 */
function matchDangerousPattern(command) {
  const cmd = String(command || '');
  if (!cmd.trim()) return null;
  return DANGEROUS_PATTERNS.find((p) => p.test(cmd)) || null;
}

module.exports = {
  DANGEROUS_PATTERNS,
  isDangerousCommand,
  matchDangerousPattern,
};

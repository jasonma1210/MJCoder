// P0-1：detached 子进程执行器——execFile 契约的 spawn 复刻版
// 为什么存在：Node 的 execFile 内部只把选项子集转发给 spawn
// （cwd/env/gid/shell/signal/uid/windowsHide/windowsVerbatimArguments），
// **detached 不在其中**——把 detached 传给 execFile 是静默无效的
// （2026-10-17 实测：execFile+detached 的子进程并非进程组组长，
// kill(-pid, 0) 恒 ESRCH，取消后孙进程全部存活）。因此本模块直接用 spawn
// 复刻 execFile 的 callback 契约（error 形状 / timeout / maxBuffer），
// 并真正落地 detached：
//   · POSIX：子进程自成进程组，取消时 killChildrenForRun 用
//     process.kill(-pid, 'SIGTERM') 整组杀灭（含 npm run build 派生的孙进程）；
//   · Windows：detached 仅表示脱离父控制台、不构成可杀进程组，取消改走
//     taskkill /T 杀进程树；windowsHide 避免控制台子进程闪出窗口。
const { spawn } = require('child_process');

/**
 * 与 execFile 同签名、同回调契约，但 detached 真实生效。
 * 与 execFile 的有意差异：maxBuffer 超限时截断输出而不终止子进程——
 * execFile 会 SIGTERM 掉整个命令，构建类命令刷屏 5MB 即被杀属于误伤
 * （stdout/stderr 下游本就有截断，长输出走 agent-core 的摘要化管道）。
 *
 * @param {string} file 可执行文件
 * @param {string[]} args 参数数组（不经过 shell）
 * @param {{ cwd?: string, timeout?: number, maxBuffer?: number, env?: object }} options
 * @param {(error: (Error & { code?: number|string|null, signal?: string|null, killed?: boolean }) | null,
 *           stdout: string, stderr: string) => void} callback
 * @returns {import('child_process').ChildProcess}
 */
function execFileDetached(file, args, options, callback) {
  const { timeout, maxBuffer = 1024 * 1024, ...rest } = options || {};
  const child = spawn(file, args, {
    ...rest,
    detached: true, // POSIX：新进程组组长（取消时可整组杀）；Windows：脱离父控制台
    windowsHide: process.platform === 'win32' ? true : rest.windowsHide,
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let settled = false;
  // maxBuffer：累计超限即截断（与 execFile 的「截断」语义一致，但不终止进程）
  const cap = (buf, chunk) => {
    const next = buf + chunk;
    return maxBuffer > 0 && next.length > maxBuffer ? next.slice(0, maxBuffer) : next;
  };
  if (child.stdout) child.stdout.on('data', (d) => { stdout = cap(stdout, d); });
  if (child.stderr) child.stderr.on('data', (d) => { stderr = cap(stderr, d); });
  let timer = null;
  if (typeof timeout === 'number' && timeout > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill(); // 与 execFile 的 timeout 行为一致：SIGTERM
    }, timeout);
  }
  const finish = (error) => {
    if (settled) return; // 'error' 与 'close' 可能都触发（ENOENT 等），只回调一次
    settled = true;
    if (timer) clearTimeout(timer);
    callback(error, stdout, stderr);
  };
  child.on('error', (err) => finish(err)); // 启动失败（ENOENT 等）：原样透传
  child.on('close', (code, signal) => {
    // 复刻 execFile 的错误形状（shellErrorNote 依赖 code/killed/signal 三态）：
    //   · 信号终止：code=null + signal，killed 仅在 timeout 触发时为 true；
    //   · 非零退出：code=数字；
    //   · 正常退出：error=null。
    let error = null;
    if (signal) {
      error = new Error(`Command failed: ${file} ${args.join(' ')}`);
      error.code = null;
      error.signal = signal;
      error.killed = timedOut;
    } else if (code !== 0) {
      error = new Error(`Command failed: ${file} ${args.join(' ')}`);
      error.code = code;
      error.killed = timedOut;
    }
    finish(error);
  });
  return child;
}

module.exports = { execFileDetached };

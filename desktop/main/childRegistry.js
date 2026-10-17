// P0-1：运行级子进程注册表（单一事实来源）——供 initToolExec（工具层直调）
// 与 initAgentRunner（编排/子代理）共用同一份 runId → Set 映射。
// 此前两处各自为政：工具层 spawn 的子进程（shell/seatbelt/bwrap/git）从未注册，
// killChildrenForRun 恒返回 0，取消运行后命令继续在后台写盘/占端口。
//
// 前提：exec.js 的 spawn 路径已统一走 execFileDetached（execFile 的 detached 选项
// 被 Node 静默丢弃，见 main/tools/execFileDetached.js 注释）——POSIX 下子进程
// 自成进程组，kill(-pid) 才能整组杀灭（含 npm run build 派生的孙进程）。
// Windows：detached 不构成可杀进程组，降级为 taskkill /T 杀进程树。

const { execFile } = require('child_process');

function createChildRegistry() {
  const active = new Map(); // runId -> Set<ChildProcess>

  // 注册：runId 缺失（渲染层直连 IPC 等无 run 上下文的调用）自动跳过
  function register(runId, child) {
    if (!runId || !child || typeof child.kill !== 'function' || !child.pid) return;
    let set = active.get(runId);
    if (!set) { set = new Set(); active.set(runId, set); }
    set.add(child);
    child.once('close', () => {
      set.delete(child);
      if (set.size === 0) active.delete(runId);
    });
  }

  // 终止：POSIX 整组 SIGTERM；Windows taskkill /T；已退出（ESRCH/EPERM）不炸
  function kill(runId) {
    const set = active.get(runId);
    if (!set) return 0;
    let n = 0;
    for (const c of set) {
      if (!c || !c.pid) continue;
      try {
        if (process.platform === 'win32') {
          execFile('taskkill', ['/pid', String(c.pid), '/T', '/F'], () => {});
        } else {
          try {
            process.kill(-c.pid, 'SIGTERM'); // detached 子进程自成进程组：整组杀灭
          } catch (e) {
            if (e.code === 'ESRCH') c.kill('SIGTERM'); // 无独立进程组（未 detached）：回落单进程
            else throw e;
          }
        }
        n += 1;
      } catch (e) {
        console.warn(`[childRegistry] 子进程终止跳过（pid=${c.pid}）：${e.code || e.message}`);
      }
    }
    return n;
  }

  // 诊断/UI 展示用
  function count(runId) { return active.get(runId)?.size || 0; }

  return { register, kill, count };
}

module.exports = { createChildRegistry };

// N2 执行契约辅助（2026-10-16，方案 §8.1 Runner 要求切片）
// 从 tools/exec.js 拆出——exec.js 逼近 800 行 God File 门禁，且 cwd 契约是独立关注点：
//   1) cwd 信任：显式 cwd 校验存在性；漏传回落宿主 getDefaultCwd()（最近项目/HOME），绝不回主进程 cwd；
//   2) 真实进程终态：shellErrorNote 对 signal/killed 的可行动描述。
// deps 由 initToolExec 注入（与 exec.js 共享同一 deps 对象）。
const path = require('path');
const fsp = require('fs/promises');

// 真实进程终态描述：退出码 / 超时 / 信号三类分开，绝不把信号终止折叠成裸失败
function shellErrorNote(error) {
  if (!error) return null;
  if (typeof error.code === 'number') {
    return `命令以退出码 ${error.code} 结束${error.killed ? '（超时被终止）' : ''}（非零退出≠失败，链式命令仅取最后一段的退出码；请以 stdout/stderr 内容为准）`;
  }
  if (error.killed) return `命令超时被终止${error.signal ? `（${error.signal}）` : ''}`;
  if (error.signal) return `命令被信号 ${error.signal} 终止（退出码未知）`;
  return String(error.message || '命令执行异常').slice(0, 300);
}

// 漏传 cwd 时的统一默认执行根（宿主注入：最近项目目录或 HOME），绝不回落主进程 cwd
function defaultToolCwd(deps) {
  if (deps && typeof deps.getDefaultCwd === 'function') {
    try { return deps.getDefaultCwd() || require('os').homedir(); } catch { /* 宿主探测失败回落 HOME */ }
  }
  return require('os').homedir();
}

// cwd 信任契约：显式 cwd 必须存在且为目录（不存在 → 结构化拒绝，绝不静默换目录执行）；
// 漏传 → 宿主默认根 + cwdFallback 标记（调用方随结果透出、审计留痕）。
async function resolveToolCwd(deps, cwd) {
  if (cwd) {
    const resolved = path.resolve(String(cwd));
    let st = null;
    try { st = await fsp.stat(resolved); } catch { /* 不存在 */ }
    if (!st || !st.isDirectory()) {
      return { ok: false, resolved, error: `工作目录不存在：${resolved}。请先用 list_dir 核对路径，或省略 cwd 由宿主提供默认工作根。` };
    }
    return { ok: true, resolved, cwdFallback: false };
  }
  return { ok: true, resolved: path.resolve(defaultToolCwd(deps)), cwdFallback: true };
}

// 工具路径解析：相对路径以项目目录（cwd）为基准，避免按主进程 CWD 解析导致 ENOENT
//（2026-10-16 自 exec.js 移入——previewTool 等单元也需要同一解析语义）
function resolveToolPath(p, cwd) {
  const raw = String(p || '');
  if (!raw) return cwd ? path.resolve(cwd) : process.cwd();
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(cwd || process.cwd(), raw);
}

module.exports = { shellErrorNote, resolveToolCwd, defaultToolCwd, resolveToolPath };

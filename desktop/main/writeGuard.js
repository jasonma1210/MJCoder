// P0-3：写路径白名单守卫（纯函数，可单测）
// 背景：写工具（write_file / edit_file / apply_patch）此前接受任意绝对路径，
// 而 auto-safe 档位对 L2 自动放行（approval.js:57）——LLM 可静默写用户主目录下任意文件。
// 规则（fail-closed）：写目标必须位于允许根目录集合内：
//   { 当前项目 cwd, 应用数据目录 userData, 系统临时目录 }
// 白名单外的写入不接受任何审批规则豁免，也不受 auto-safe 自动放行，必须显式审批。

const path = require('path');
const os = require('os');
const fs = require('fs');

// 目录包含判定：target 在 root 内（含 root 本身），不受符号链接外的 ../ 逃逸影响
function isWithinRoot(target, root) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// 允许写根目录集合：项目目录 + 应用数据目录 + 系统临时目录。
// macOS 的 os.tmpdir() 返回 /var/folders/...（不覆盖 /tmp 符号链接路径），
// 因此非 Windows 平台额外把 /tmp 纳入白名单——临时目录下的合法工作不应反复触发审批。
function allowedWriteRoots({ cwd, userDataDir, tmpDir } = {}) {
  const roots = [];
  if (cwd) roots.push(path.resolve(cwd));
  if (userDataDir) roots.push(path.resolve(userDataDir));
  roots.push(path.resolve(tmpDir || os.tmpdir()));
  if (process.platform !== 'win32') roots.push('/tmp');
  return roots;
}

// 返回第一个越界目标（绝对路径）；全部在界内返回 null。
// 相对路径按 base（通常为项目 cwd）解析。
function firstOutsideTarget(targets, roots, base) {
  for (const t of targets || []) {
    const raw = String(t || '').trim();
    if (!raw) continue;
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base || process.cwd(), raw);
    if (!roots.some((r) => isWithinRoot(abs, r))) return abs;
  }
  return null;
}

// unified diff 目标提取：+++ / --- 行（apply_patch 用 -p1 剥离一层前缀，这里同样剥离 a/ b/）
function patchTargets(patch) {
  const out = [];
  for (const line of String(patch || '').split('\n')) {
    const m = line.match(/^(?:\+\+\+|---)\s+(\S+)/);
    if (!m || m[1] === '/dev/null') continue;
    // 剥离 git diff 惯例前缀 a/ b/（与 patch -p1 语义一致）
    out.push(m[1].replace(/^[ab]\//, ''));
  }
  return out;
}

// ── 可写区内的只读 carve-out（对齐 Codex 当前 Linux 沙箱的做法）──
//
// 背景：workspace-write 档把整个项目目录设为可写，但其中有几处**不应**可写：
//   · `.git` —— 改写 `.git/hooks/pre-commit` 后，用户下次手动 `git commit` 就会执行被注入的代码。
//     这是从「沙箱内」逃到「沙箱外」的既成路径，且不依赖任何漏洞：沙箱只约束 Agent 当前进程，
//     约束不了用户之后自己敲的命令。Codex 在可写根内把 `.git`（含解析出的 gitdir）重新挂为只读，
//     本项目对齐该做法。
//   · 应用自身配置目录（项目内如存在）—— 改写它等于让 Agent 调自己的治理参数。
//
// 注意：只保护精确的 `.git` 路径及其**目录内容**；`.gitignore` / `.gitmodules` 等
// 「以 .git 开头的普通文件」不在保护范围内（用 isWithinRoot 做路径包含判定，天然区分二者）。
const PROTECTED_SUBPATH_NAMES = ['.git', '.mjcode'];

/**
 * 列出该项目下**实际存在**的受保护路径（绝对路径）。
 *
 * 两个必须处理的真实形态：
 *   ① 普通仓库：`.git` 是目录 → 保护该目录；
 *   ② worktree / submodule：`.git` 是**文件**，内容形如 `gitdir: /abs/path/.git/worktrees/x`
 *      → 真正的 gitdir 在别处（甚至可能在项目目录之外），必须一并保护，否则只是把绕过点换了位置。
 *
 * @param {string} cwd 项目目录
 * @param {{existsSync?: Function, readFileSync?: Function}} [io] 便于单测注入
 * @returns {string[]} 受保护绝对路径（含 gitdir 目标）
 */
function protectedPathsFor(cwd, { existsSync = fs.existsSync, readFileSync = fs.readFileSync } = {}) {
  const out = [];
  if (!cwd) return out;
  const base = path.resolve(cwd);
  for (const name of PROTECTED_SUBPATH_NAMES) {
    const p = path.join(base, name);
    let exists = false;
    try { exists = !!existsSync(p); } catch { exists = false; }
    if (!exists) continue;
    out.push(p);
    // 形态 ②：`.git` 是文件（读目录会抛 EISDIR，正好把两种形态区分开）
    try {
      const m = String(readFileSync(p, 'utf8')).match(/^gitdir:\s*(.+)$/m);
      if (m) {
        const gitDir = path.resolve(base, m[1].trim());
        if (!out.includes(gitDir)) out.push(gitDir);
      }
    } catch { /* 目录形态或不可读：不影响其余保护项 */ }
  }
  return out;
}

/**
 * 返回第一个落在受保护区内的写目标（绝对路径）；全部安全则返回 null。
 * 相对路径按 base（通常为项目 cwd）解析。
 */
function firstProtectedTarget(targets, protectedPaths, base) {
  if (!Array.isArray(protectedPaths) || protectedPaths.length === 0) return null;
  for (const t of targets || []) {
    const raw = String(t || '').trim();
    if (!raw) continue;
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base || process.cwd(), raw);
    if (protectedPaths.some((p) => isWithinRoot(abs, p))) return abs;
  }
  return null;
}

module.exports = {
  isWithinRoot,
  allowedWriteRoots,
  firstOutsideTarget,
  patchTargets,
  PROTECTED_SUBPATH_NAMES,
  protectedPathsFor,
  firstProtectedTarget,
};

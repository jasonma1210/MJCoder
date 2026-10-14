// P0-3：写路径白名单守卫（纯函数，可单测）
// 背景：写工具（write_file / edit_file / apply_patch）此前接受任意绝对路径，
// 而 auto-safe 档位对 L2 自动放行（approval.js:57）——LLM 可静默写用户主目录下任意文件。
// 规则（fail-closed）：写目标必须位于允许根目录集合内：
//   { 当前项目 cwd, 应用数据目录 userData, 系统临时目录 }
// 白名单外的写入不接受任何审批规则豁免，也不受 auto-safe 自动放行，必须显式审批。

const path = require('path');
const os = require('os');

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

module.exports = { isWithinRoot, allowedWriteRoots, firstOutsideTarget, patchTargets };

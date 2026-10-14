// P1 遗留项：Worker 真并行隔离——每个子任务在独立 git worktree 中改代码，完成后 patch 合并回主目录
// 背景：Worker 池默认并发 4，多任务直接同写一个工作目录会互相覆盖（真机风险）。
// 方案：dispatch 前建 worktree（复用 worktree.js）→ Worker 在副本内干活 → 任务结束
//       `git add -A + diff --cached --binary` 生成全量补丁（含新增/二进制文件）→
//       主目录 `git apply --check` 预检 → 可合并则 apply，冲突则补丁落盘待人工处理。
// 降级：非 git 仓库 / worktree 创建失败 → 回落直接在主目录执行（现状行为），不阻塞任务。
// 开关：环境变量 MJCODE_WORKTREE_ISOLATION=0 可整体关闭。
const fs = require('fs');
const path = require('path');
const wt = require('./worktree');

const KILL_SWITCH = () => process.env.MJCODE_WORKTREE_ISOLATION === '0';

/** 为子任务创建隔离 worktree；不可隔离（非 git/失败/关闭）返回 null（调用方回落主目录） */
async function createIsolated({ cwd, groupId, taskId }) {
  if (KILL_SWITCH() || !cwd) return null;
  try {
    if (!(await wt.isGitRepo(cwd))) return null;
    const w = await wt.createWorktree(cwd, `worker-${groupId}-${taskId}`.slice(0, 60));
    return { worktreePath: w.path, branch: w.branch, repoRoot: w.repoRoot };
  } catch (e) {
    console.warn(`[workerIso] 创建隔离工作区失败（回落主目录执行）: ${e.message}`);
    return null;
  }
}

/**
 * 把 worktree 内的全部改动合并回主目录。
 * 返回 { ok, applied, conflicts, patchFile } —— conflicts 时补丁已落盘待人工处理。
 */
async function mergeBackIsolated({ cwd, iso }) {
  if (!iso?.worktreePath) return { ok: true, applied: false, skipped: '无隔离工作区' };
  const out = { ok: false, applied: false, conflicts: false, patchFile: null };
  try {
    // 1. 全量暂存（含新增/删除/二进制），生成相对 HEAD（=任务起点）的补丁
    await wt.git(iso.worktreePath, ['add', '-A'], 60000);
    const diff = await wt.git(iso.worktreePath, ['diff', '--cached', '--binary'], 60000);
    if (!diff.ok) throw new Error(`生成补丁失败：${diff.stderr || diff.error}`);
    if (!diff.stdout.trim()) { out.ok = true; return out; } // 无改动，直接清理

    // 2. 主目录预检（apply --check 不落盘）；冲突 → 补丁落盘待人工
    const applyCheck = await wt.git(cwd, ['apply', '--check', '--binary', '-'], 30000, diff.stdout);
    if (!applyCheck.ok) {
      const dir = path.join(require('os').homedir(), '.mjcode', 'worktree-conflicts');
      fs.mkdirSync(dir, { recursive: true });
      out.patchFile = path.join(dir, `${path.basename(iso.worktreePath)}.patch`);
      fs.writeFileSync(out.patchFile, diff.stdout);
      out.conflicts = true;
      out.error = `补丁与主目录当前内容冲突，已保存到 ${out.patchFile}`;
      return out;
    }
    const apply = await wt.git(cwd, ['apply', '--binary', '-'], 60000, diff.stdout);
    if (!apply.ok) throw new Error(`补丁应用失败：${apply.stderr || apply.error}`);
    out.ok = true;
    out.applied = true;
    return out;
  } catch (e) {
    out.error = e.message;
    return out;
  } finally {
    // 3. 清理 worktree 与分支（无论合并成败——改动已体现在补丁/主目录中）
    try { await wt.removeWorktree(iso.worktreePath, true); } catch { /* 清理尽力而为 */ }
    try { await wt.git(iso.repoRoot || cwd, ['branch', '-D', iso.branch]); } catch { /* 分支清理尽力而为 */ }
  }
}

/** 失败/中止路径：丢弃 worktree（不合并），返回清理结果 */
async function discardIsolated({ iso }) {
  if (!iso?.worktreePath) return false;
  try { await wt.removeWorktree(iso.worktreePath, true); } catch { return false; }
  try { await wt.git(iso.repoRoot, ['branch', '-D', iso.branch]); } catch { /* 尽力而为 */ }
  return true;
}

module.exports = { createIsolated, mergeBackIsolated, discardIsolated };

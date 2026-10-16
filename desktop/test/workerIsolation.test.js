// P1 遗留项 workerIsolation 集成测试（真实临时 git 仓库）：
// createIsolated 建树 / 干净合并回主目录 / 冲突补丁落盘 / 失败丢弃清理 / 非 git 回落 null
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { createIsolated, mergeBackIsolated, discardIsolated } = require('../main/workerIsolation');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-iso-test-'));
  sh(dir, ['init', '-q']);
  sh(dir, ['config', 'user.email', 'test@local']);
  sh(dir, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, 'app.txt'), 'line1\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

let conflictPatchToClean = null;

(async () => {
  const repo = makeTempRepo();

  // ── 非 git 目录 → 回落 null ──
  const notGit = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-nogit-'));
  check('非 git 目录 createIsolated 返回 null（回落主目录）',
    (await createIsolated({ cwd: notGit, groupId: 'g0', taskId: 't0' })) === null);

  // ── 创建隔离工作区 ──
  const iso = await createIsolated({ cwd: repo, groupId: 'g1', taskId: 'task-1' });
  check('git 仓库创建隔离 worktree 成功', !!iso?.worktreePath && fs.existsSync(iso.worktreePath));
  check('worktree 分支名以 mjcode/ 前缀命名', (iso?.branch || '').startsWith('mjcode/worker-g1-'));
  check('worktree 内容与主目录一致（含初始文件）',
    fs.readFileSync(path.join(iso.worktreePath, 'app.txt'), 'utf8') === 'line1\n');

  // ── 干净路径：worktree 内改动 → 合并回主目录 ──
  fs.writeFileSync(path.join(iso.worktreePath, 'app.txt'), 'line1\nline2-worker\n');
  fs.writeFileSync(path.join(iso.worktreePath, 'new.txt'), 'brand new\n');
  const merged = await mergeBackIsolated({ cwd: repo, iso });
  check('合并 ok 且 applied=true', merged.ok === true && merged.applied === true, JSON.stringify(merged));
  check('主目录文件已被更新',
    fs.readFileSync(path.join(repo, 'app.txt'), 'utf8') === 'line1\nline2-worker\n');
  check('worktree 内新增文件已同步到主目录', fs.existsSync(path.join(repo, 'new.txt')));
  check('worktree 已清理（目录不存在）', !fs.existsSync(iso.worktreePath));
  check('临时分支已删除', !sh(repo, ['branch', '--list', iso.branch]).trim());

  // ── 冲突路径：主目录内容与补丁基线不一致 → 补丁落盘 ──
  const iso2 = await createIsolated({ cwd: repo, groupId: 'g2', taskId: 'task-2' });
  fs.writeFileSync(path.join(iso2.worktreePath, 'app.txt'), 'line1\nline2-worker\nCONFLICT-MARK\n');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'main-side change\n'); // 主目录并行改动 → 冲突
  const conflicted = await mergeBackIsolated({ cwd: repo, iso: iso2 });
  check('冲突时 conflicts=true 且不落主目录', conflicted.conflicts === true && conflicted.applied === false);
  check('冲突补丁已落盘到 ~/.mjcode/worktree-conflicts',
    !!conflicted.patchFile && fs.existsSync(conflicted.patchFile));
  check('主目录内容未被冲突合并覆盖', fs.readFileSync(path.join(repo, 'app.txt'), 'utf8') === 'main-side change\n');
  // V06 契约（2026-10-16）：冲突时 **保留 worktree 现场**（成果可取回），
  // 由调用方写 needs_review 状态并显式 discard —— 不再「清理后标完成」。
  check('冲突路径保留 worktree 现场（V06 成果不丢）', fs.existsSync(iso2.worktreePath));
  check('冲突时 worktree 内改动仍在', fs.existsSync(path.join(iso2.worktreePath, 'app.txt')));
  check('显式 discard 后 worktree 清理', (await discardIsolated({ iso: iso2 })) === true && !fs.existsSync(iso2.worktreePath));
  conflictPatchToClean = conflicted.patchFile;

  // ── 无改动路径：ok 且 applied=false ──
  const iso3 = await createIsolated({ cwd: repo, groupId: 'g3', taskId: 'task-3' });
  const empty = await mergeBackIsolated({ cwd: repo, iso: iso3 });
  check('无改动时 ok=true、applied=false', empty.ok === true && empty.applied === false);

  // ── 失败路径：丢弃 worktree，主目录不受影响 ──
  const iso4 = await createIsolated({ cwd: repo, groupId: 'g4', taskId: 'task-4' });
  fs.writeFileSync(path.join(iso4.worktreePath, 'dirty.txt'), 'should be discarded\n');
  check('discardIsolated 返回 true', (await discardIsolated({ iso: iso4 })) === true);
  check('丢弃后 worktree 不存在', !fs.existsSync(iso4.worktreePath));
  check('丢弃不影响主目录', !fs.existsSync(path.join(repo, 'dirty.txt')));

  // ── mergeBackIsolated 对空 iso 的容错 ──
  const skipped = await mergeBackIsolated({ cwd: repo, iso: null });
  check('iso 为 null 时安全跳过', skipped.ok === true && skipped.applied === false);

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(notGit, { recursive: true, force: true });
  if (conflictPatchToClean) { try { fs.unlinkSync(conflictPatchToClean); } catch { /* 尽力清理 */ } }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });

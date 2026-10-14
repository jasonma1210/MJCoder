// Worktree 隔离工作区：真仓库上的端到端验证（创建 → 改文件 → 收口 → 清理）
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const worktree = require('../main/worktree');

let pass = 0;
let total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

const gitBin = fs.existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git';
function sh(cwd, args) {
  const { execFileSync } = require('child_process');
  return execFileSync(gitBin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-wt-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  sh(repo, ['init', '-q']);
  sh(repo, ['config', 'user.email', 't@t.io']);
  sh(repo, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# base\n');
  sh(repo, ['add', '.']);
  sh(repo, ['commit', '-qm', 'init']);

  let wt = null;

  await check('识别 Git 仓库', async () => {
    assert.equal(await worktree.isGitRepo(repo), true);
  });

  await check('非 Git 目录判定为 false', async () => {
    assert.equal(await worktree.isGitRepo(tmp), false);
  });

  await check('worktree 存放于用户级固定目录（不污染项目）', () => {
    assert.equal(worktree.worktreeRoot(), path.join(os.homedir(), '.mjcode', 'worktrees'));
  });

  await check('创建隔离工作区成功，主目录不受影响', async () => {
    wt = await worktree.createWorktree(repo, '修复登录跳转');
    assert.ok(fs.existsSync(wt.path));
    assert.ok(wt.branch.startsWith('mjcode/'));
    assert.ok(wt.branch.includes('修复登录跳转') || wt.branch.includes('mjcode/'));
    // 主检出目录不应出现新文件
    assert.equal(fs.existsSync(path.join(repo, 'NEW.md')), false);
  });

  await check('工作区内改动与主目录物理隔离', async () => {
    fs.writeFileSync(path.join(wt.path, 'NEW.md'), 'only in worktree\n');
    assert.equal(fs.existsSync(path.join(wt.path, 'NEW.md')), true);
    assert.equal(fs.existsSync(path.join(repo, 'NEW.md')), false);
  });

  await check('列出 worktree 并正确标记主检出目录', async () => {
    // 注意：在 worktree 内执行 rev-parse --show-toplevel 返回的是 worktree 自身，
    // 主检出目录必须从原始项目目录解析（这是本模块最容易踩的坑）
    const root = await worktree.repoRoot(repo);
    const list = await worktree.listWorktrees(root, root);
    assert.ok(list.length >= 2, `预期至少 2 个，实际 ${list.length}`);
    assert.equal(list.filter((w) => w.isMain).length, 1);
    // macOS 下 git 输出 realpath（/private/var/...），需归一化后比较
    const norm = (p) => fs.realpathSync(p);
    assert.ok(list.some((w) => norm(w.path) === norm(wt.path) && !w.isMain),
      `未在列表中找到工作区：${list.map((w) => w.path).join(', ')}`);
  });

  await check('收口方式一：转为正式分支（改名为 mj/ 前缀）', async () => {
    const r = await worktree.promoteToBranch(wt.path);
    assert.ok(r.branch.startsWith('mj/'), r.branch);
    assert.ok(!r.branch.startsWith('mjcode/'));
  });

  await check('收口方式二：主目录干净时可同步回本地', async () => {
    const r = await worktree.syncToLocal(wt.path);
    assert.ok(r.branch.startsWith('mjcode/sync-'));
  });

  await check('主目录存在未提交改动时同步被拒绝（fail-closed）', async () => {
    fs.writeFileSync(path.join(repo, 'DIRTY.md'), 'x');
    await assert.rejects(() => worktree.syncToLocal(wt.path), /未提交改动/);
    fs.unlinkSync(path.join(repo, 'DIRTY.md'));
  });

  await check('清理隔离工作区', async () => {
    await worktree.removeWorktree(wt.path);
    assert.equal(fs.existsSync(wt.path), false);
  });

  await check('清理不存在的路径时报中文错误', async () => {
    await assert.rejects(() => worktree.removeWorktree(path.join(tmp, 'nope')), /无法定位|移除失败/);
  });

  await check('非 Git 项目创建工作区被拒绝', async () => {
    await assert.rejects(() => worktree.createWorktree(tmp, 'x'), /不是 Git 仓库/);
  });

  await check('未选项目时报中文错误', async () => {
    await assert.rejects(() => worktree.createWorktree('', 'x'), /未选择项目/);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  // 清掉本轮创建的 worktree 残留
  try {
    const root = await worktree.repoRoot(repo);
    if (root) {
      const list = await worktree.listWorktrees(root, root);
      for (const w of list.filter((x) => !x.isMain)) await worktree.removeWorktree(w.path);
    }
  } catch { /* 清理失败不影响断言结论 */ }
  console.log(`\nPASS：${pass}/${total} 项通过`);
})();
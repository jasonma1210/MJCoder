// 可写区内的只读 carve-out（对齐 Codex 沙箱架构）——纯函数行为测试
//
// 保护对象：项目目录内的 `.git`（含 worktree/submodule 的 gitdir）与应用自身配置目录。
// 动机：workspace-write 档把整个项目目录设为可写，会连带把 `.git` 变可写；
//   改写 `.git/hooks/pre-commit` 后，用户下次手动 `git commit` 即执行被注入的代码——
//   沙箱只约束 Agent 当前进程，约束不了用户之后自己敲的命令。
//
// 本测试全部为行为断言（直接喂路径看结果），不读源码字符串。
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  PROTECTED_SUBPATH_NAMES,
  protectedPathsFor,
  firstProtectedTarget,
} = require('../main/writeGuard');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass += 1; }
  catch (e) { console.error(`❌ ${name} — ${e.message}`); fail += 1; }
}

const CWD = path.join(path.sep, 'repo');
const GIT_DIR = path.join(CWD, '.git');

/** 构造注入式 io：只有列在 exists 里的路径“存在” */
function io({ exists = [], gitdirContent = null } = {}) {
  return {
    existsSync: (p) => exists.includes(p),
    readFileSync: (p) => {
      if (p === GIT_DIR && gitdirContent) return gitdirContent; // 文件形态
      const err = new Error('EISDIR: illegal operation on a directory');
      err.code = 'EISDIR';
      throw err;
    },
  };
}

// ── 清单构建 ──
check('无项目目录 → 不产生保护项（无 cwd 即无可保护范围）', () => {
  assert.deepEqual(protectedPathsFor(''), []);
  assert.deepEqual(protectedPathsFor(null), []);
});

check('目录形态：存在 .git 时列入保护', () => {
  const out = protectedPathsFor(CWD, io({ exists: [GIT_DIR] }));
  assert.deepEqual(out, [GIT_DIR]);
});

check('不存在 .git 时保护清单为空（不虚构保护项）', () => {
  assert.deepEqual(protectedPathsFor(CWD, io({ exists: [] })), []);
});

check('文件形态（worktree/submodule）：解析 gitdir 并一并保护', () => {
  const realGitDir = path.join(path.sep, 'main-repo', '.git', 'worktrees', 'wt1');
  const out = protectedPathsFor(CWD, io({ exists: [GIT_DIR], gitdirContent: `gitdir: ${realGitDir}\n` }));
  assert.equal(out.includes(GIT_DIR), true, '应保护 .git 本身');
  assert.equal(out.includes(realGitDir), true, `应保护真实 gitdir（${realGitDir}）`);
});

check('文件形态：相对 gitdir 按项目目录解析', () => {
  const out = protectedPathsFor(CWD, io({ exists: [GIT_DIR], gitdirContent: 'gitdir: ../主仓/.git/worktrees/wt1\n' }));
  const expected = path.resolve(CWD, '../主仓/.git/worktrees/wt1');
  assert.equal(out.includes(expected), true, `实际=${JSON.stringify(out)}`);
});

check('保护项清单与常量同源（新增项不会漏测）', () => {
  assert.ok(Array.isArray(PROTECTED_SUBPATH_NAMES) && PROTECTED_SUBPATH_NAMES.includes('.git'));
});

// ── 命中判定 ──
check('命中：.git 目录内的 hook 文件', () => {
  const hit = firstProtectedTarget([path.join(GIT_DIR, 'hooks', 'pre-commit')], [GIT_DIR], CWD);
  assert.equal(hit, path.join(GIT_DIR, 'hooks', 'pre-commit'));
});

check('命中：.git 目录本身与 git config', () => {
  assert.ok(firstProtectedTarget([GIT_DIR], [GIT_DIR], CWD));
  assert.ok(firstProtectedTarget([path.join(GIT_DIR, 'config')], [GIT_DIR], CWD));
});

check('命中：相对路径按 base 解析后判定', () => {
  const hit = firstProtectedTarget(['.git/hooks/pre-commit'], [GIT_DIR], CWD);
  assert.equal(hit, path.join(GIT_DIR, 'hooks', 'pre-commit'));
});

check('不命中：.gitignore / .gitmodules 等「以 .git 开头的普通文件」', () => {
  assert.equal(firstProtectedTarget([path.join(CWD, '.gitignore')], [GIT_DIR], CWD), null);
  assert.equal(firstProtectedTarget([path.join(CWD, '.gitmodules')], [GIT_DIR], CWD), null);
  assert.equal(firstProtectedTarget([path.join(CWD, '.gitattributes')], [GIT_DIR], CWD), null);
});

check('不命中：兄弟目录 .github（前缀相似但不同目录）', () => {
  assert.equal(firstProtectedTarget([path.join(CWD, '.github', 'workflows', 'ci.yml')], [GIT_DIR], CWD), null);
});

check('不命中：项目内的普通源码文件', () => {
  assert.equal(firstProtectedTarget([path.join(CWD, 'src', 'index.js')], [GIT_DIR], CWD), null);
});

check('不命中：项目外路径（由白名单闸负责，不重复拦）', () => {
  assert.equal(firstProtectedTarget(['/tmp/scratch.txt'], [GIT_DIR], CWD), null);
});

check('不命中：上文目录内的同名文件（.. 逃逸不误判）', () => {
  // /repo/.git 的保护不应牵连 /repo2/.git/hooks/x
  assert.equal(firstProtectedTarget([path.join(path.sep, 'repo2', '.git', 'hooks', 'x')], [GIT_DIR], CWD), null);
});

check('空输入安全：无目标或无保护项一律返回 null', () => {
  assert.equal(firstProtectedTarget([], [GIT_DIR], CWD), null);
  assert.equal(firstProtectedTarget([path.join(GIT_DIR, 'config')], [], CWD), null);
  assert.equal(firstProtectedTarget([path.join(GIT_DIR, 'config')], null, CWD), null);
  assert.equal(firstProtectedTarget([''], [GIT_DIR], CWD), null);
});

check('多目标：任一命中即返回该目标（apply_patch 场景）', () => {
  const targets = ['src/a.js', '.git/hooks/pre-commit'];
  assert.equal(firstProtectedTarget(targets, [GIT_DIR], CWD), path.join(GIT_DIR, 'hooks', 'pre-commit'));
});

check('worktree 的真实 gitdir 在项目外时同样命中', () => {
  const external = path.join(path.sep, 'main-repo', '.git', 'worktrees', 'wt1');
  assert.equal(
    firstProtectedTarget([path.join(external, 'config')], [GIT_DIR, external], CWD),
    path.join(external, 'config'),
  );
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);

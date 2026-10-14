// 写路径白名单守卫测试：目录包含判定 / 根目录集合 / patch 目标提取与越界检测
const { isWithinRoot, allowedWriteRoots, firstOutsideTarget, patchTargets } = require('../main/writeGuard');
const os = require('os');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── isWithinRoot ──
check('根目录本身在界内', isWithinRoot('/proj', '/proj'));
check('子路径在界内', isWithinRoot('/proj/src/a.js', '/proj'));
check('目录名前缀不等于包含（/project ≠ /proj）', !isWithinRoot('/project-evil/x.js', '/proj'));
check('../ 逃逸被拒', !isWithinRoot('/proj/../secret.txt', '/proj'));
check('绝对路径逃逸被拒', !isWithinRoot('/etc/passwd', '/proj'));

// ── allowedWriteRoots ──
const roots = allowedWriteRoots({ cwd: '/work/proj', userDataDir: '/Users/x/Library/Application Support/MJCoder' });
check('根目录集合：cwd + userData + 系统临时目录 + /tmp', roots.length === 4);
check('无 cwd 时为 userData + 临时目录 + /tmp', allowedWriteRoots({ userDataDir: '/ud' }).length === 3);

// ── firstOutsideTarget：写入目标检查 ──
check('项目内相对路径放行', firstOutsideTarget(['src/a.js'], roots, '/work/proj') === null);
check('项目内绝对路径放行', firstOutsideTarget(['/work/proj/src/a.js'], roots, '/work/proj') === null);
check('userData 内放行', firstOutsideTarget(['/Users/x/Library/Application Support/MJCoder/settings.json'], roots) === null);
check('系统临时目录放行', firstOutsideTarget([`${os.tmpdir()}/out.txt`], roots) === null);
const outside = firstOutsideTarget(['/Users/x/Desktop/evil.sh'], roots, '/work/proj');
check('主目录越界被检出', outside === '/Users/x/Desktop/evil.sh');
check('越界路径返回绝对路径', typeof outside === 'string');

// ── patchTargets：提取 +++/--- 目标 ──
const patch = `--- a/src/ok.js
+++ b/src/ok.js
@@ -1,3 +1,3 @@
-old
+new
--- /dev/null
+++ b/README.md`;
check('提取 patch 目标并剥离 a/ b/ 前缀', JSON.stringify(patchTargets(patch)) === JSON.stringify(['src/ok.js', 'src/ok.js', 'README.md']));
check('patch 目标在 cwd 内放行', firstOutsideTarget(patchTargets(patch), roots, '/work/proj') === null);
const evilPatch = `--- /etc/hosts
+++ /etc/hosts
@@ -1 +1 @@
-bad
+good`;
check('patch 写 /etc 被检出越界', firstOutsideTarget(patchTargets(evilPatch), roots, '/work/proj') === '/etc/hosts');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);

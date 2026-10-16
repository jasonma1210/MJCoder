// 测试总入口（2026-10-15 门禁加固）
//
// 背景（真机事故）：`npm test` 原为 83 个套件用 `&&` 串联，任一套件**崩溃**（非断言失败，
//   而是 ERR_DLOPEN_FAILED 这类顶层抛错导致进程非零退出）会中断整条链，其后所有套件
//   **静默不执行**。实测 orchestrator.test.js 因 better-sqlite3 与 Node ABI 不匹配崩溃后，
//   其后 41 个套件（含全部 M3/M4 新能力）从未被跑过，而 CI 照样亮绿——门禁假绿。
//
// 改为「发现式 + 全量跑完 + 末尾汇总」：
//   1. 发现式：自动发现 test/*.test.{js,mjs} + 两个 smoke 套件，新增套件**无需注册**即被
//      跑到（此前 role-preset.test.mjs 就是漏注册的活证据）。
//   2. 全量跑完：单套件崩溃只记录，不阻断后续；最后按失败清单以非零退出码报错。
//   3. 汇总输出：FAIL 列表集中在末尾，一眼看到「哪些没过、哪些崩了」，不再被截断在中间。
//
// 保留既有的顺序执行（不并发）：多套件共用 tmpdir / 全局 stub，并发会互相污染。
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');

// 套件发现：*.test.js / *.test.mjs（目录自动发现，防漏注册）+ 明确登记的 smoke 套件
// （smoke-*.mjs 不叫 *.test.*，故单独列出；它们是加载冒烟，同样必须进基线）。
const SMOKE = ['smoke-load.mjs', 'render-smoke.mjs'];

function discover() {
  const tests = readdirSync(TEST_DIR)
    .filter((f) => /\.test\.(js|mjs)$/.test(f))
    .sort()
    .map((f) => `test/${f}`);
  const smoke = SMOKE
    .filter((f) => existsSync(path.join(TEST_DIR, f)))
    .map((f) => `test/${f}`);
  // smoke 先跑：加载冒烟挂了说明渲染层/主进程加载即炸，后续套件结果无参考价值，应尽早暴露
  return [...smoke, ...tests];
}

const suites = discover();
const failed = [];   // 非零退出（断言失败 或 崩溃）
const crashed = [];  // 崩溃特指：套件自身进程异常退出（含未捕获异常 / NODE_MODULE_VERSION 不匹配等）
const skipped = [];  // C2（2026-10-16）：套件内明确声明的「跳过/未执行」行（如非 Linux 平台跳过 bwrap 真机探测）

console.log(`发现 ${suites.length} 个测试套件（发现式，无需注册）\n`);

for (const [i, suite] of suites.entries()) {
  const label = `[${String(i + 1).padStart(2)}/${suites.length}] ${suite}`;
  const started = Date.now();
  // 单套件超时 180s：卡死套件不应拖死整条基线（超时记失败并继续）
  const r = spawnSync(process.execPath, [path.join(ROOT, suite)], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
    killSignal: 'SIGKILL',
  });
  const ms = Date.now() - started;
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  const body = `${r.stdout || ''}${r.stderr || ''}`;
  // 崩溃特征：非断言失败，而是套件进程自身没跑完（加载期抛错 / 信号终止 / 超时）
  const isCrash = timedOut
    || (r.status !== 0 && r.status !== 1)
    || (r.signal != null)
    || /ERR_DLOPEN_FAILED|MODULE_NOT_FOUND|SyntaxError|NODE_MODULE_VERSION/.test(body);

  // C2：把「平台相关未执行」显式记账——套件 PASS 不等于该平台已验证，
  // 汇总里单列这些行，避免「全绿」被误读为「所有平台行为都已覆盖」。
  for (const line of body.split('\n')) {
    if (/⚠.*(跳过|未执行)/.test(line)) skipped.push({ suite, detail: line.trim().slice(0, 160) });
  }

  if (r.status === 0) {
    console.log(`✅ ${label}  (${ms}ms)`);
  } else {
    failed.push(suite);
    if (isCrash) crashed.push({ suite, detail: timedOut ? '超时(>180s)' : (r.signal || `exit ${r.status}`) });
    console.log(`❌ ${label}  (${ms}ms)${isCrash ? '  [崩溃/超时]' : ''}`);
    // 保留失败上下文，便于就地定位（全量跑完 + 失败详情不被中间日志冲掉）
    console.log(body.trim().split('\n').slice(-8).map((l) => `      ${l}`).join('\n'));
  }
}

console.log('\n──────── 测试基线汇总 ────────');
console.log(`总计 ${suites.length} · 通过 ${suites.length - failed.length} · 失败 ${failed.length}`);
if (failed.length > 0) {
  console.log(`\n失败套件（${failed.length}）：`);
  for (const s of failed) console.log(`  ✗ ${s}`);
}
if (crashed.length > 0) {
  console.log(`\n崩溃/超时（${crashed.length}）—— 这类是套件没跑完，务必修复后重跑基线：`);
  for (const c of crashed) console.log(`  ✗ ${c.suite} — ${c.detail}`);
  console.log('  提示：better-sqlite3 报 NODE_MODULE_VERSION 时，先 `npm rebuild better-sqlite3`');
}
if (skipped.length > 0) {
  console.log(`\n未执行/跳过（${skipped.length}）—— 这些**不代表已验证**，对应平台需单独跑：`);
  for (const s of skipped) console.log(`  ⚠ ${s.suite} — ${s.detail}`);
}
process.exit(failed.length === 0 ? 0 : 1);

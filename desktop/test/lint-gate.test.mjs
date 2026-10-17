// X14 回归门禁：让「npm test 全绿」≡「CI 的 lint 门禁绿」。
//
// 为什么必须单独一条（2026-10-18 第二次被同一类问题咬）：
//   `.github/workflows/*.yml` 里 lint 是 **error 门禁**（`eslint ... --quiet`，0 error 才过），
//   而 `npm test`（test/run-all.mjs）跑的是各测试套件——两者口径不同。于是出现了这种状态：
//   120+ 套件全绿、`npm test` 退出码 0，但 `npm run lint` 是红的，CI 直接红，release job 连启动
//   机会都没有（needs: verify 卡死）。具体触发事件是 X14 把 tasks:* 搬进 ipc/tasks.js 时漏改
//   main.js 里 `hostPolicySnapshot` 的调用点，`node --check` 抓不到跨作用域引用，只有 no-undef 报错。
//
// 本用例把 lint 纳入测试面：跑与 npm 脚本**同一范围**、**同一份配置**，断言 0 error。
// 注意：
//   · 用 `--quiet`（只报 error）——0 error 是硬门禁；用 `--max-warnings=0` 会被存量 warning 常年判红；
//   · 环境里没有 eslint（离线 clone / 未装依赖）时打印 ⚠ 并跳过，不误报（同 untracked-deps 的处理）；
//   · 直接 spawn 本地 node_modules/.bin/eslint，避免 npx 在缺依赖时联网下载。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// 与 package.json 的 `lint` 脚本同范围（main/ agent-core/ renderer/src/ chrome-extension/），
// 加 --quiet 对齐 CI 的 error 门禁口径
const LINT_ARGS = ['main/', 'agent-core/', 'renderer/src/', 'chrome-extension/', '--quiet'];

function resolveEslintBin() {
  const candidates = [
    path.join(DESKTOP, 'node_modules/.bin/eslint'),
    path.join(DESKTOP, '..', 'node_modules/.bin/eslint'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const bin = resolveEslintBin();

if (!bin) {
  // 非「装了依赖」的环境：门禁无法判定，跳过而非误报（同时把原因打出来，避免静默失效）
  console.log('[SKIP] ⚠ 未找到本地 eslint（node_modules/.bin/eslint），跳过 lint 门禁');
} else {
  const res = spawnSync(bin, LINT_ARGS, {
    cwd: DESKTOP,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const stdout = `${res.stdout || ''}${res.stderr || ''}`;
  const status = res.status;

  check('eslint 可执行为 0 error（= CI 的 lint 门禁口径，--quiet）', () => {
    if (status === 0) return;
    // 逐条列出 error 行，把「哪一行」直接摊在测试输出里——跑一次就能定位，不必再手动复跑
    const errors = stdout.split('\n').filter((l) => /\serror\s/.test(l));
    throw new Error(
      `eslint 退出码 ${status}（${errors.length} 条 error）。修好后本门禁即绿：\n`
      + (errors.length ? errors.slice(0, 30).join('\n') : stdout.slice(0, 4000)),
    );
  });
}

console.log(`\nlint-gate: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);

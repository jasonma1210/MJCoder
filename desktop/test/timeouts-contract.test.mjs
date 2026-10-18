#!/usr/bin/env node
// 超时契约门禁（P3：把「散落字面量」变成「单一来源 + 可断言的不变式」）
//
// 缺陷形态：patching/grep/find/git 的实现侧超时散在 exec.js 五处；编排的单任务墙钟与
// 组等待上限分居 dag.js 与 invoke.js，互不知情。后果不是崩溃，而是**调一个数时
// 永远不知道还有几处需要同步**（P1-2 的「三处超时互不自洽」就是这么来的）。
//
// 本套件锁两层：
//   ① 数值不变式：实现侧 < 看门狗；组等待 >= 单任务最大；min < default < max
//   ② 接线事实：dag/invoke/exec 真的引用常量，不允许回落到字面量
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = require(path.join(DESKTOP, 'main/tools/timeouts.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── ① 数值存在且为正 ────────────────────────────
const NAMES = [
  'SHELL_DEFAULT_TIMEOUT_MS', 'SHELL_WATCHDOG_TIMEOUT_MS',
  'WEB_FETCH_IMPL_TIMEOUT_MS', 'WEB_FETCH_WATCHDOG_TIMEOUT_MS',
  'PATCH_IMPL_TIMEOUT_MS', 'GREP_IMPL_TIMEOUT_MS', 'FIND_IMPL_TIMEOUT_MS',
  'GIT_IMPL_TIMEOUT_MS', 'GIT_QUICK_TIMEOUT_MS',
  'ORCHESTRATE_TASK_MIN_MS', 'ORCHESTRATE_TASK_DEFAULT_MS',
  'ORCHESTRATE_TASK_MAX_MS', 'ORCHESTRATE_GROUP_WAIT_MS',
];
check('全部超时常量已导出且为正数',
  NAMES.every((n) => Number.isFinite(T[n]) && T[n] > 0),
  NAMES.filter((n) => !(Number.isFinite(T[n]) && T[n] > 0)).join(',') || `${NAMES.length} 个`);

// ── ② 不变式：实现侧 < 看门狗 ───────────────────
// 否则引擎看门狗永远轮不到报错（P1-2 的原始缺陷：实现 60s 自己先断，看门狗 600s 空转）
check('shell：实现侧严格小于看门狗',
  T.SHELL_DEFAULT_TIMEOUT_MS < T.SHELL_WATCHDOG_TIMEOUT_MS,
  `${T.SHELL_DEFAULT_TIMEOUT_MS} < ${T.SHELL_WATCHDOG_TIMEOUT_MS}`);
check('web_fetch：实现侧严格小于看门狗',
  T.WEB_FETCH_IMPL_TIMEOUT_MS < T.WEB_FETCH_WATCHDOG_TIMEOUT_MS,
  `${T.WEB_FETCH_IMPL_TIMEOUT_MS} < ${T.WEB_FETCH_WATCHDOG_TIMEOUT_MS}`);

// ── ③ 编排两级墙钟的关系 ────────────────────────
check('编排：min < default < max',
  T.ORCHESTRATE_TASK_MIN_MS < T.ORCHESTRATE_TASK_DEFAULT_MS
  && T.ORCHESTRATE_TASK_DEFAULT_MS < T.ORCHESTRATE_TASK_MAX_MS);
check('编排：组等待 >= 单任务最大（至少容纳一个满预算任务）',
  T.ORCHESTRATE_GROUP_WAIT_MS >= T.ORCHESTRATE_TASK_MAX_MS,
  `${T.ORCHESTRATE_GROUP_WAIT_MS} >= ${T.ORCHESTRATE_TASK_MAX_MS}`);
check('编排：单任务默认 10min（与 UI 文案「单任务预算」一致）',
  T.ORCHESTRATE_TASK_DEFAULT_MS === 10 * 60 * 1000);

// ── ④ 接线事实：不允许回落字面量 ────────────────
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8');
const exec = read('main/tools/exec.js');
const dag = read('main/orchestrator/dag.js');
const invoke = read('main/orchestrator/invoke.js');

check('exec.js 引用 timeouts 常量（不再硬编码）',
  /require\('\.\/timeouts'\)/.test(exec) && /PATCH_IMPL_TIMEOUT_MS/.test(exec));
check('exec.js 无残留 `timeout: <数字>` 字面量',
  !/timeout:\s*\d/.test(exec),
  (exec.match(/timeout:\s*\d/g) || []).join(','));
check('dag.js 引用编排常量',
  /ORCHESTRATE_TASK_(MIN|DEFAULT|MAX)_MS/.test(dag) && /require\('\.\.\/tools\/timeouts'\)/.test(dag));
check('invoke.js 引用组等待常量',
  /ORCHESTRATE_GROUP_WAIT_MS/.test(invoke) && /require\('\.\.\/tools\/timeouts'\)/.test(invoke));
check('invoke.js 无残留 `30 * 60 * 1000` 字面量',
  !/30\s*\*\s*60\s*\*\s*1000/.test(invoke));

console.log(`\ntimeouts-contract: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;

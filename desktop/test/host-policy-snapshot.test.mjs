// V04 回归门禁：编排建组的「宿主治理快照」（main/approvalPolicy.js hostPolicySnapshot）。
//
// 为什么要单独测：这是每次「对话内编排 / tasks:autoRun / tasks:plan」建组时**随组持久化**的
// 治理快照，Worker 执行时直接读它决定审批档与沙箱档。两处调用点（main.js 的 orchestrate_task
// 工具、ipc/tasks.js 的 tasks:*）各自 import 同一个纯函数——一旦被改坏，表现是「子任务在
// 用户设了『全部询问』的情况下仍自动放行」，与 approvalPolicy.js 头部记录的历史事故同型。
//
// 2026-10-18 事故背景：X14 把 tasks:* 搬进 ipc/tasks.js 时，本函数的**调用点**留在 main.js 却没同步，
// 导致 orchestrate_task 一被调用就 ReferenceError。该事故已由 test/lint-gate.test.mjs 兜住
// （no-undef 是唯一能发现的静态手段）；本文件兜住**逻辑正确性**这一层。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { hostPolicySnapshot, APPROVAL_ORDER } = require(path.join(DESKTOP, 'main/approvalPolicy.js'));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

check('有工作目录 → workspace-write（子任务可在项目内写）', () => {
  const s = hostPolicySnapshot('/tmp/proj', 'on-request');
  if (s.sandboxPolicy !== 'workspace-write') throw new Error(`sandboxPolicy=${s.sandboxPolicy}`);
});

check('无工作目录 → read-only（最容易被改坏的一行：漏判等于给出无隔离写权限）', () => {
  for (const cwd of ['', null, undefined]) {
    const s = hostPolicySnapshot(cwd, 'on-request');
    if (s.sandboxPolicy !== 'read-only') throw new Error(`cwd=${String(cwd)} → ${s.sandboxPolicy}`);
  }
});

check('审批档原样透传（合法枚举不被改写）', () => {
  for (const mode of Object.keys(APPROVAL_ORDER)) {
    const s = hostPolicySnapshot('/tmp/p', mode);
    if (s.approvalMode !== mode) throw new Error(`${mode} 被改写成 ${s.approvalMode}`);
  }
});

check('非法/缺省审批档归一化为默认档（不许把不存在的档位随组快照落盘）', () => {
  for (const mode of ['yolo', '', null, undefined, 123]) {
    const s = hostPolicySnapshot('/tmp/p', mode);
    if (!(s.approvalMode in APPROVAL_ORDER)) throw new Error(`非法档 ${String(mode)} 原样落盘：${s.approvalMode}`);
    if (s.approvalMode !== 'on-request') throw new Error(`${String(mode)} 归一化到 ${s.approvalMode}（应 on-request）`);
  }
});

check('零依赖纯函数：返回值只含 governance 两字段（不接受模型参数混入快照）', () => {
  const s = hostPolicySnapshot('/tmp/p', 'always');
  const keys = Object.keys(s).sort();
  if (keys.join(',') !== 'approvalMode,sandboxPolicy') throw new Error(`快照字段异常：${keys.join(',')}`);
});

console.log(`\nhost-policy-snapshot: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);

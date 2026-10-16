// N5 rootExecution 统一取消行为验收（2026-10-16）：
//   1) cancelByRun：该 run 的挂起审批全部按 deny 撤下（渲染层 onSettle 照常触发撤卡），
//      其他 run / 无 runId 的挂起审批不受影响；
//   2) 取消链路贯通：工具执行中的审批（deps.requestApproval 挂 runId）在 run 取消时
//      自动 deny → 工具结果为「用户拒绝执行」，不再悬挂到 120s 超时；
//   3) 子进程随运行终止：exec.js 注册的 shell 子进程在 killChildrenForRun 后收到 SIGTERM，
//      工具结果如实上报 signal。
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// electron stub（exec.js 顶层依赖）
const electronStub = {
  app: { getPath: () => '/tmp/mjcode-n5c', on: () => {}, whenReady: () => Promise.resolve() },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: { openPath: async () => '', openExternal: async () => '', showItemInFolder: () => {} },
};
const electronPath = require.resolve('electron');
const stubModule = new Module(electronPath, null);
stubModule.filename = electronPath;
stubModule.loaded = true;
stubModule.exports = electronStub;
require.cache[electronPath] = stubModule;

require('../main/audit/auditLog').initAudit({ getAuthToken: () => null, serverBase: () => 'http://localhost:0' });
const { ApprovalChannel } = require('../main/approvalChannel');
const { toolShell } = require('../main/tools/exec');
const { initToolExec } = require('../main/tools/exec');

// ── 1) cancelByRun 单元语义 ──
{
  const ch = new ApprovalChannel({ timeoutMs: 60000 });
  const settled = [];
  ch.wait('ap-1', (id, reason) => settled.push([id, reason]), 'run-A');
  ch.wait('ap-2', (id, reason) => settled.push([id, reason]), 'run-A');
  ch.wait('ap-3', (id, reason) => settled.push([id, reason]), 'run-B');
  ch.wait('ap-4', (id, reason) => settled.push([id, reason]), null);
  const n = ch.cancelByRun('run-A');
  check('cancelByRun: 撤下该 run 的全部挂起审批', n === 2 && ch.size === 2, `撤下 ${n}`);
  check('cancelByRun: 其他 run / 无 runId 的审批不受影响', ch.dispatch('ap-3', 'once') === true && ch.dispatch('ap-4', 'deny') === true);
  check('cancelByRun: 决策按 deny + run-cancelled 理由收尾', settled.filter(([id]) => id === 'ap-1' || id === 'ap-2').every(([, reason]) => reason === 'run-cancelled'));
  check('cancelByRun: 未知 runId 返回 0', ch.cancelByRun('run-none') === 0 && ch.cancelByRun(null) === 0);
}

// ── 2) 取消链路贯通：审批中的工具调用被 run 取消自动 deny ──
(async () => {
  const DEFAULT_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-n5c-'));
  const channel = new ApprovalChannel({ timeoutMs: 30000 });
  const registeredChildren = new Set();
  // 模拟 main.js 的 runScope（AsyncLocalStorage）注入结果：requestApproval 从「当前 run 上下文」取 runId
  let currentRunId = null;
  initToolExec({
    requestApproval: (tool, args) => channel.wait(channel.nextId(), undefined, currentRunId),
    applyApprovalDecision: () => {},
    getAlwaysRules: () => [],
    conversationRules: [],
    getDefaultCwd: () => DEFAULT_CWD,
    // 模拟 main.js registerChild：注册到 runId（测试直接捕获子进程）
    registerChild: (child) => { registeredChildren.add(child); },
  });

  // 场景 A：rm -rf（命中危险模式 → 必审批）在 run-A 内发起；取消 run-A → 审批自动 deny，命令不执行
  currentRunId = 'run-A';
  const targetDir = path.join(DEFAULT_CWD, 'target');
  fs.mkdirSync(targetDir, { recursive: true });
  const p1 = toolShell({ command: `rm -rf ${targetDir}`, cwd: DEFAULT_CWD, sandboxPolicy: 'full-access', requireApproval: true });
  await new Promise((r) => setTimeout(r, 30)); // 让审批挂起
  check('取消链路: 审批挂起中', channel.size === 1);
  const cancelled = channel.cancelByRun('run-A');
  check('取消链路: run 取消撤下审批', cancelled === 1);
  const resA = await p1;
  check('取消链路: 工具调用按用户拒绝收尾（不悬挂到超时）', String(resA.stderr).includes('用户拒绝执行') && resA.blocked !== true && resA.exitCode === -1, `stderr=${String(resA.stderr).slice(0, 40)}`);
  check('取消链路: 命令未执行（目标目录仍在）', fs.existsSync(targetDir));

  // 场景 B：子进程随运行终止——长睡眠命令注册为 run-B 子进程，killChildrenForRun 后 SIGTERM
  currentRunId = 'run-B';
  const p2 = toolShell({ command: 'sleep 30', cwd: DEFAULT_CWD, sandboxPolicy: 'full-access', requireApproval: false });
  await new Promise((r) => setTimeout(r, 200)); // 等子进程 spawn
  check('子进程: 已注册到运行', registeredChildren.size >= 1);
  let killed = 0;
  for (const c of registeredChildren) { try { c.kill('SIGTERM'); killed += 1; } catch { /* 已退出 */ } }
  const resB = await p2;
  check('子进程: killChildrenForRun 后子进程被终止（signal 透出）', killed >= 1 && resB.signal === 'SIGTERM', `signal=${resB.signal}`);

  fs.rmSync(DEFAULT_CWD, { recursive: true, force: true });
  console.log(`\n──── N5 rootExecution 取消验收汇总：通过 ${pass} · 失败 ${fail} ────`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });

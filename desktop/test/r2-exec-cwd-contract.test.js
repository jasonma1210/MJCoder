// N2 执行契约行为验收（2026-10-16，方案 §8.1 Runner 要求切片）：
//   1) cwd 信任：不存在的 cwd → 结构化拒绝，绝不静默换目录执行；
//   2) 漏传 cwd → 回落宿主 getDefaultCwd()（最近项目/HOME），绝不回主进程 cwd，结果 cwdFallback 标记；
//   3) 结果携带真实执行目录（模型/用户可核对执行位置）；
//   4) 真实进程终态：signal/killed 透出，信号终止不再折叠成裸 -1；
//   5) runGit 漏传 cwd 同契约。
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

// ── electron stub（exec.js 顶层 require('electron')；本测试不经 IPC）──
const electronStub = {
  app: { getPath: () => '/tmp/mjcode-n2-electron', on: () => {}, whenReady: () => Promise.resolve() },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: { openPath: async () => '', openExternal: async () => '', showItemInFolder: () => {} },
};
const electronPath = require.resolve('electron');
const stubModule = new Module(electronPath, null);
stubModule.filename = electronPath;
stubModule.loaded = true;
stubModule.exports = electronStub;
require.cache[electronPath] = stubModule;

const { toolShell, runGit } = require('../main/tools/exec');

// auditLog 自身依赖注入（getAuthToken=null → 本地落盘留痕路径，不发起上报）
require('../main/audit/auditLog').initAudit({ getAuthToken: () => null, serverBase: () => 'http://localhost:0' });

const DEFAULT_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-n2-default-'));
const PROJECT_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-n2-project-'));

// 注入宿主依赖：getDefaultCwd 返回受控临时目录（≠ 测试进程 cwd）
const { initToolExec } = require('../main/tools/exec');
initToolExec({
  requestApproval: async () => 'once',
  applyApprovalDecision: () => {},
  getAlwaysRules: () => [],
  conversationRules: [],
  getDefaultCwd: () => DEFAULT_CWD,
  // P0-1：exec.js 去掉 ?. 后 registerChild 为必需接线（缺失即抛错）——本测试不验证取消链路，注入 no-op
  registerChild: () => {},
});

(async () => {
  // 1) 漏传 cwd → 宿主默认根 + cwdFallback 标记（full-access 走直跑路径，聚焦 cwd 契约）
  const r1 = await toolShell({ command: 'pwd', sandboxPolicy: 'full-access', requireApproval: false });
  check('N2: 漏传 cwd 回落宿主默认根', r1.cwd === DEFAULT_CWD, `cwd=${r1.cwd}`);
  check('N2: 回落显式标记 cwdFallback=true', r1.cwdFallback === true);
  check('N2: 绝不回主进程 cwd', r1.cwd !== process.cwd());
  check('N2: 命令实际在默认根执行（pwd 一致）', String(r1.stdout).trim() === fs.realpathSync(DEFAULT_CWD));

  // 2) 显式 cwd → 结果携带真实执行目录
  const r2 = await toolShell({ command: 'pwd', cwd: PROJECT_CWD, sandboxPolicy: 'full-access', requireApproval: false });
  check('N2: 显式 cwd 时结果携带该目录', r2.cwd === path.resolve(PROJECT_CWD) && r2.cwdFallback === undefined);
  check('N2: 命令在显式 cwd 执行', String(r2.stdout).trim() === fs.realpathSync(path.resolve(PROJECT_CWD)));

  // 3) 不存在的 cwd → 结构化拒绝（不执行、可行动错误）
  const r3 = await toolShell({ command: 'echo should-not-run', cwd: '/tmp/mjcode-n2-not-exist-xyz', sandboxPolicy: 'full-access', requireApproval: false });
  check('N2: cwd 不存在时 blocked', r3.blocked === true && r3.error === 'cwd-not-found');
  check('N2: cwd 不存在时命令未执行', String(r3.stdout).trim() === '');
  check('N2: 拒绝信息含解析后路径（可行动）', String(r3.stderr).includes('/tmp/mjcode-n2-not-exist-xyz'));

  // 4) 真实进程终态：信号终止透出 signal（full-access 直跑路径）
  const r4 = await toolShell({ command: 'kill -TERM $$', cwd: PROJECT_CWD, sandboxPolicy: 'full-access', requireApproval: false });
  check('N2: 信号终止透出 signal=SIGTERM', r4.signal === 'SIGTERM', `signal=${r4.signal}, error=${r4.error}`);
  check('N2: 信号终止不以 exitCode 0 谎报成功', r4.exitCode !== 0);

  // 5) 正常退出 signal 为 null（不污染成功路径）
  const r5 = await toolShell({ command: 'echo ok', cwd: PROJECT_CWD, sandboxPolicy: 'full-access', requireApproval: false });
  check('N2: 正常退出 signal=null', r5.signal === null && r5.exitCode === 0);

  // 6) runGit 漏传 cwd → 宿主默认根（结果携带 cwd）
  const r6 = await runGit(['--version']);
  check('N2: runGit 漏传 cwd 回落宿主默认根', r6.cwd === DEFAULT_CWD && r6.error === null);

  fs.rmSync(DEFAULT_CWD, { recursive: true, force: true });
  fs.rmSync(PROJECT_CWD, { recursive: true, force: true });

  console.log(`\n──── N2 cwd 契约验收汇总：通过 ${pass} · 失败 ${fail} ────`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });

// N2 ShellProfile + argv 优先 / N3 describeCapability 行为验收（2026-10-16）：
//   1) 字符串命令走显式 ShellProfile（/bin/sh -c 非交互，零语义漂移）；
//   2) argv 数组完全绕开 shell：$HOME 不展开、含空格参数原样传递（判别性证据）；
//   3) argv 启动失败（ENOENT）结构化上报；
//   4) argvToShellCommand 转义正确（Linux/Windows 降级路径）；
//   5) describeCapability 结构化能力描述（嵌套沙箱环境诚实标记）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// electron stub（exec.js 顶层依赖；本测试不经 IPC）
const electronStub = {
  app: { getPath: () => '/tmp/mjcode-n2b', on: () => {}, whenReady: () => Promise.resolve() },
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
const { toolShell } = require('../main/tools/exec');
const { initToolExec } = require('../main/tools/exec');
const { resolveShellProfile, argvToShellCommand } = require('../main/cmd/shellProfile');
const sandbox = require('../main/sandbox');

const DEFAULT_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-n2b-'));
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
  // 1) ShellProfile：显式 /bin/sh -c
  const sp = resolveShellProfile();
  check('ShellProfile: darwin 用 /bin/sh -c（显式契约，零语义漂移）', process.platform !== 'win32'
    ? sp.exe === '/bin/sh' && sp.args.includes('-c') && sp.ok === true
    : sp.ok === true, `${sp.exe} ${sp.args.join(' ')}`);

  // 2) argv 优先：完全绕开 shell（$HOME 不展开 + 空格参数原样传递）
  const r1 = await toolShell({ argv: ['/bin/echo', '$HOME', 'a b'], sandboxPolicy: 'full-access', requireApproval: false });
  check('argv: $HOME 不被 shell 展开（字面量传递）', String(r1.stdout).trim() === '$HOME a b', JSON.stringify(r1.stdout));
  check('argv: 结果真实（exitCode 0，无 error）', r1.exitCode === 0 && r1.error === null);

  // 3) 字符串命令照常（ShellProfile 路径）：$HOME 会被展开——两条路径语义可区分
  const r2 = await toolShell({ command: 'echo $HOME', cwd: DEFAULT_CWD, sandboxPolicy: 'full-access', requireApproval: false });
  check('字符串命令: shell 路径下 $HOME 正常展开（语义未漂移）', String(r2.stdout).trim() === String(process.env.HOME));

  // 4) argv 启动失败（ENOENT）→ 结构化错误
  const r3 = await toolShell({ argv: ['/nonexistent/mjcode-probe-bin', 'x'], sandboxPolicy: 'full-access', requireApproval: false });
  check('argv: 启动失败结构化上报（ENOENT）', r3.exitCode !== 0 && /ENOENT|no such file/i.test(String(r3.error) + String(r3.stderr)));

  // 5) argv 空数组 → blocked
  const r4 = await toolShell({ argv: [], sandboxPolicy: 'full-access', requireApproval: false });
  check('argv: 空数组 blocked（argv-empty）', r4.blocked === true && r4.error === 'argv-empty');

  // 6) argvToShellCommand 转义（Linux/Windows 降级路径用）
  check('argvToShellCommand: 空格与单引号转义正确', argvToShellCommand(['a b', "it's"]) === "'a b' 'it'\\''s'");

  // 7) describeCapability（嵌套沙箱环境 → available:false + nestedSandbox 标记）
  const cap = await sandbox.describeCapability();
  check('describeCapability: 结构完整', typeof cap.available === 'boolean' && typeof cap.nestedSandbox === 'boolean' && !!cap.backend);
  if (process.platform === 'darwin' && cap.nestedSandbox) {
    check('describeCapability: 嵌套沙箱环境诚实标记', cap.available === false && cap.nestedSandbox === true && /嵌套沙箱/.test(cap.reason));
  }

  fs.rmSync(DEFAULT_CWD, { recursive: true, force: true });
  console.log(`\n──── N2 ShellProfile/argv + N3 能力描述验收汇总：通过 ${pass} · 失败 ${fail} ────`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });

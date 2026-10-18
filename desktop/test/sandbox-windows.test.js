// P1-4 门禁：Windows OS 级沙箱后端的纯函数级验证。
//
// 背景：Windows 沙箱后端本轮补齐了「设置入口 + read-only/workspace-write 分档 +
//   .git/.mjcode carve-out」三件事（见 main/sandboxWindows.js 头注释）。本机是 macOS，
//   无法真机验证提权 / icacls / schtasks 行为，故后端把「可验证的部分」全部写成
//   可注入 runFn/platform 的纯函数构造 + 执行分离：命令构造、脚本渲染、分档判定、
//   ACL 序列都在本套件里断言；真机提权/ACL 的实际结果留待 Windows CI（本文件不假装已验证）。
//
// 覆盖（对应施工单 5 项）：
//   A. windowsSandboxPlan() 形状不变（steps/rollback、占位符、必含步骤）
//   B. renderSandboxSetupScript() 含全部步骤 + 回滚，且回滚确在失败分支
//   C. generateSandboxPassword() 长度与随机性、字符集安全
//   D. buildWindowsExec() 三档分档（full-access / read-only / workspace-write）
//   E. applyWorkspaceAcl() 的 carve-out deny 参数与 fail-closed（注入 runFn + platform）
const fs = require('fs');
const os = require('os');
const path = require('path');
const windows = require('../main/sandboxWindows');

let pass = 0;
let total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message || e}`); process.exitCode = 1; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  // ── A. 设置计划形状（对外契约不变）──
  const plan = windows.windowsSandboxPlan();
  await check('A1 windowsSandboxPlan 返回 {steps, rollback} 且形状不变', () => {
    assert(Array.isArray(plan.steps) && Array.isArray(plan.rollback), 'steps/rollback 必须是数组');
    const keys = Object.keys(plan).sort();
    assert(keys.join(',') === 'rollback,steps', `形状变化：${keys.join(',')}`);
  });
  await check('A2 每个 step 含 id/cmd/args/note', () => {
    assert(plan.steps.length > 0, 'steps 不能为空');
    for (const s of plan.steps) {
      assert(s.id && s.cmd && Array.isArray(s.args) && s.note, `step ${s.id} 字段不完整`);
    }
  });
  await check('A3 计划含四个必含步骤', () => {
    const ids = plan.steps.map((s) => s.id);
    for (const id of ['create-offline-user', 'create-online-user', 'deny-interactive-logon', 'block-outbound-firewall']) {
      assert(ids.includes(id), `缺少步骤 ${id}`);
    }
  });
  await check('A4 密码以占位符下发，命令行不得出现明文', () => {
    assert(JSON.stringify(plan.steps).includes('<RANDOM_PASSWORD>'), '未找到 <RANDOM_PASSWORD> 占位符');
  });
  await check('A5 rollback 至少含两条撤销命令', () => {
    assert(plan.rollback.length >= 2, `rollback 太短：${plan.rollback.length}`);
  });

  // ── B. 设置脚本渲染（含失败即回滚）──
  const password = 'Ab9-xZ_0.Qw@3#eRt7~Yui1vBn2';
  const script = windows.renderSandboxSetupScript(plan, password);
  await check('B1 脚本含全部步骤的 id 注释与命令', () => {
    for (const s of plan.steps) {
      assert(script.includes(`[${s.id}]`), `脚本缺少步骤注释 [${s.id}]`);
      assert(script.includes(s.cmd), `脚本缺少命令 ${s.cmd}`);
    }
  });
  await check('B2 每步以非零退出触发失败（$LASTEXITCODE 判据）', () => {
    assert(script.includes('$LASTEXITCODE -ne 0'), '缺少 $LASTEXITCODE 判据');
    assert(script.includes('throw '), '缺少 throw 失败中断');
  });
  await check('B3 真实密码经单引号字面量注入，且占位符已全部替换', () => {
    assert(script.includes(password), '脚本未注入真实密码');
    assert(!script.includes('<RANDOM_PASSWORD>'), '占位符未替换（会泄露未处理状态）');
  });
  await check('B4 脚本含全部回滚命令（失败时可撤销）', () => {
    for (const c of plan.rollback) assert(script.includes(c), `脚本缺少回滚命令：${c}`);
  });
  await check('B5 回滚调用确在失败分支内，且步骤在 try 体内', () => {
    const failStart = script.indexOf('if ($null -ne $mjcodeFailed)');
    const failEnd = script.indexOf('exit 1', failStart);
    assert(failStart > -1 && failEnd > failStart, '未找到失败分支');
    const failBlock = script.slice(failStart, failEnd);
    assert(/Invoke-MjcodeRollback/.test(failBlock), '失败分支未调用回滚');
    // 注意：回滚函数定义内部也含 `try { … } catch { … }`，故须取**最后**一组 try/catch（主流程）
    const tryBody = script.slice(script.lastIndexOf('try {'), script.lastIndexOf('} catch {'));
    for (const s of plan.steps) assert(tryBody.includes(`[${s.id}]`), `步骤 ${s.id} 不在 try 体内`);
    assert(!tryBody.includes('Invoke-MjcodeRollback\n'), 'try 体内不应出现回滚调用');
  });
  await check('B6 脚本以 exit 0 / exit 1 双出口收尾（不伪造成功）', () => {
    assert(script.includes('exit 0') && script.includes('exit 1'), '缺少退出码出口');
  });

  // ── C. 密码生成 ──
  await check('C1 默认长度 32，指定长度生效，短值有下限', () => {
    assert(windows.generateSandboxPassword().length === 32, '默认长度非 32');
    assert(windows.generateSandboxPassword(24).length === 24, '指定长度未生效');
    assert(windows.generateSandboxPassword(4).length === 16, '未施加 16 字符下限');
  });
  await check('C2 字符集只含对 PowerShell/net 安全的字符（无引号/元字符）', () => {
    const p = windows.generateSandboxPassword(200);
    assert(/^[A-Za-z0-9\-_.@#+=~]+$/.test(p), `含不安全字符：${p}`);
  });
  await check('C3 两次生成不重复（随机性）', () => {
    assert(windows.generateSandboxPassword() !== windows.generateSandboxPassword(), '两次生成相同，疑似非随机');
  });

  // ── D. buildWindowsExec 三档分档 ──
  const CWD = 'C:\\proj';
  const full = windows.buildWindowsExec('full-access', CWD, 'whoami');
  await check('D1 full-access：不沙箱（空 argv），带 backend/tier 元信息', () => {
    assert(full.argv.length === 0, 'full-access 不应生成 argv');
    assert(full.tier === 'full-access' && full.backend === 'windows-restricted-user', `tier/backend 异常：${full.tier}/${full.backend}`);
  });
  const ro = windows.buildWindowsExec('read-only', CWD, 'ls');
  await check('D2 read-only：以受限用户执行，且不授予工作区写权限', () => {
    assert(ro.argv.length > 0, 'read-only 应生成 argv');
    assert(ro.argv[0] === 'schtasks' && ro.argv.includes('LIMITED'), 'read-only 未走受限 schtasks');
    assert(ro.argv.includes(windows.SANDBOX_USER_OFFLINE), 'read-only 未指定专用用户');
    assert(ro.tier === 'read-only', `tier 应为 read-only：${ro.tier}`);
    assert(ro.requiresWorkspaceAcl !== true, 'read-only 不应要求工作区 ACL');
  });
  const www = windows.buildWindowsExec('workspace-write', CWD, 'npm test');
  await check('D3 workspace-write：需 cwd 且显式标注 requiresWorkspaceAcl', () => {
    assert(www.argv.length > 0 && www.argv[0] === 'schtasks', 'workspace-write 未走 schtasks');
    assert(www.tier === 'workspace-write', `tier 应为 workspace-write：${www.tier}`);
    assert(www.requiresWorkspaceAcl === true, 'workspace-write 应要求工作区 ACL');
    assert(/^MJCodeSandbox_Run_\d+_\d+$/.test(www.taskName || ''), `taskName 格式异常：${www.taskName}`);
  });
  await check('D4 workspace-write 缺项目目录时拒绝（空 argv）', () => {
    assert(windows.buildWindowsExec('workspace-write', '', 'x').argv.length === 0, '缺 cwd 仍生成 argv');
  });
  await check('D5 read-only 无需 cwd（隔离在「不给写权限」，而非路径）', () => {
    assert(windows.buildWindowsExec('read-only', '', 'ls').argv.length > 0, 'read-only 不应依赖 cwd');
  });

  // ── E. 工作区 ACL：carve-out deny + fail-closed ──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-winsbx-'));
  const gitDir = path.join(tmp, '.git');
  fs.mkdirSync(gitDir);
  const gitFile = path.join(tmp, 'note.txt');
  fs.writeFileSync(gitFile, 'x');
  try {
    await check('E1 writeDenyAce：目录用 (OI)(CI)W 传导，文件用裸 W', () => {
      const dirAce = windows.writeDenyAce(gitDir, 'MJCodeSandboxOffline');
      const fileAce = windows.writeDenyAce(gitFile, 'MJCodeSandboxOffline');
      assert(dirAce === 'MJCodeSandboxOffline:(OI)(CI)W', `目录 ACE 异常：${dirAce}`);
      assert(fileAce === 'MJCodeSandboxOffline:W', `文件 ACE 异常：${fileAce}`);
    });
    await check('E2 buildWorkspaceAclCommands：顺序为 remove-inheritance → grant → deny-carveout → system-read', () => {
      const built = windows.buildWorkspaceAclCommands(tmp, 'MJCodeSandboxOffline', [gitDir]);
      assert(built.ok, `构造失败：${built.error}`);
      const ids = built.commands.map((c) => c.id);
      assert(ids[0] === 'remove-inheritance' && ids[1] === 'grant-workspace-write', `顺序异常：${ids.join(',')}`);
      const deny = built.commands.find((c) => c.id === 'deny-carveout');
      assert(deny, '缺少 deny-carveout 命令');
      assert(deny.cmd === 'icacls' && deny.args.includes('/deny'), 'carve-out 未走 icacls /deny');
      assert(deny.args.includes('MJCodeSandboxOffline:(OI)(CI)W'), `carve-out ACE 异常：${deny.args.join(' ')}`);
      assert(ids[ids.length - 1] === 'grant-system-read', '未保留 SYSTEM 读取');
    });
    await check('E3 buildWorkspaceAclCommands：缺 cwd 时拒绝', () => {
      assert(windows.buildWorkspaceAclCommands('', 'u', []).ok === false, '缺 cwd 仍构造成功');
    });
    await check('E4 applyWorkspaceAcl：注入 runFn 真实下发 carve-out deny（win32）', async () => {
      const calls = [];
      const runFn = async (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, code: 0, stdout: '', stderr: '' }; };
      const res = await windows.applyWorkspaceAcl(tmp, 'MJCodeSandboxOffline', [gitDir], { runFn, platform: 'win32' });
      assert(res.ok, `执行未通过：${res.error}`);
      const denyCall = calls.find((c) => c.includes('/deny'));
      assert(denyCall, '未下发 /deny 调用');
      assert(denyCall.includes('MJCodeSandboxOffline:(OI)(CI)W'), `deny 参数异常：${denyCall.join(' ')}`);
      assert(res.carveouts && res.carveouts.some((c) => c.path === gitDir && c.ok), 'carve-out 未记录');
    });
    await check('E5 applyWorkspaceAcl：carve-out 失败即 fail-closed（整体判失败）', async () => {
      const runFn = async (cmd, args) => (/\/deny/.test(args.join(' '))
        ? { ok: false, code: 1, stdout: '', stderr: 'Access is denied.' }
        : { ok: true, code: 0, stdout: '', stderr: '' });
      const res = await windows.applyWorkspaceAcl(tmp, 'MJCodeSandboxOffline', [gitDir], { runFn, platform: 'win32' });
      assert(res.ok === false, 'carve-out 失败却判为成功（逃生面未守住）');
      assert(/carve-out 失败/.test(res.error || ''), `错误文案未标注 carve-out：${res.error}`);
    });
    await check('E6 applyWorkspaceAcl：非 Windows 平台直接拒绝（不伪造可用）', async () => {
      const res = await windows.applyWorkspaceAcl(tmp, 'u', [], { runFn: async () => ({ ok: true }), platform: 'darwin' });
      assert(res.ok === false && res.error === '非 Windows 平台', `非 win32 未拒绝：${JSON.stringify(res)}`);
    });
    await check('E7 applyWindowsSandboxSetup / teardown：非 win32 返回 not-supported', async () => {
      const s = await windows.applyWindowsSandboxSetup({ platform: 'darwin', seal: () => Buffer.from('x'), storageDir: tmp });
      assert(s.ok === false && s.error === 'not-supported', `setup 未拒绝：${JSON.stringify(s)}`);
      const t = await windows.windowsSandboxTeardown({ platform: 'darwin', storageDir: tmp });
      assert(t.ok === false && t.error === 'not-supported', `teardown 未拒绝：${JSON.stringify(t)}`);
    });
    await check('E8 applyWindowsSandboxSetup：无 seal（无 DPAPI）时**执行前**拒绝，不落明文', async () => {
      let ran = false;
      const s = await windows.applyWindowsSandboxSetup({
        platform: 'win32', storageDir: tmp,
        runFn: async () => { ran = true; return { ok: true, code: 0, stdout: '', stderr: '' }; },
      });
      assert(s.ok === false && s.error === 'no-seal', `未拒绝：${JSON.stringify(s)}`);
      assert(ran === false, '无 seal 时不应执行提权（否则会创建出密码无法安全保存的用户）');
    });
    await check('E9 windowsIsElevated：net session 成功即已提权（win32，注入 runFn）', async () => {
      const up = await windows.windowsIsElevated({ platform: 'win32', runFn: async () => ({ ok: true }) });
      const down = await windows.windowsIsElevated({ platform: 'win32', runFn: async () => ({ ok: false }) });
      assert(up.elevated === true && down.elevated === false, '提权探测结果异常');
      const non = await windows.windowsIsElevated({ platform: 'darwin', runFn: async () => ({ ok: true }) });
      assert(non.elevated === false, '非 win32 不应报告已提权');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\nsandbox-windows: ${pass}/${total} 通过`);
  process.exit(process.exitCode ? 1 : (pass === total ? 0 : 1));
})();

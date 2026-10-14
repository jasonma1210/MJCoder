// P0-E：GitHub 最小闭环（gh CLI 封装）—— execFn 注入式单测，不依赖本机 gh
const assert = require('node:assert/strict');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); fail++; process.exitCode = 1; }
}
// 异步布尔断言助手（check 接收同步函数）
function checkOk(name, ok, detail = '') {
  if (ok) { console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`); pass++; }
  else { console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); fail++; process.exitCode = 1; }
}

const { ghAvailable, ghAuthed, createPullRequest } = require('../main/github.js');

// 构造 execFn stub：按调用序返回脚本化结果
function scriptExec(script) {
  const calls = [];
  const execFn = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    const next = script.shift();
    if (!next) { cb(new Error('unexpected call'), '', ''); return; }
    if (next.error) { cb(next.error, next.stdout || '', next.stderr || ''); return; }
    cb(null, next.stdout || '', next.stderr || '');
  };
  return { execFn, calls };
}

(async () => {
  // 1. gh 已安装
  {
    const { execFn, calls } = scriptExec([{ stdout: 'gh version 2.62.0 (2025-06-01)\nhttps://github.com/cli/cli/releases/tag/v2.62.0' }]);
    const ok = await ghAvailable(execFn);
    checkOk('gh 已安装 → available=true', ok === true);
    checkOk('探测用 --version 参数', calls[0].cmd === 'gh' && calls[0].args[0] === '--version');
  }

  // 2. gh 未安装（ENOENT）
  {
    const err = new Error('spawn gh ENOENT');
    const { execFn } = scriptExec([{ error: err }]);
    checkOk('gh 未安装 → available=false', (await ghAvailable(execFn)) === false);
  }

  // 3. 已登录 / 未登录
  {
    const { execFn } = scriptExec([{ stdout: 'github.com\n  Logged in to github.com account jasonma (keyring)' }]);
    const authed = await ghAuthed(execFn);
    checkOk('gh auth status 退出码 0 → authed=true', authed.ok === true && authed.detail.includes('Logged in'));
  }
  {
    const { execFn } = scriptExec([{ error: new Error('exit 1'), stderr: 'You are not logged into any GitHub hosts.' }]);
    const authed = await ghAuthed(execFn);
    checkOk('未登录 → authed=false 且带回 stderr 详情', authed.ok === false && authed.detail.includes('not logged'));
  }

  // 4. 创建 PR 成功：解析 stdout 中的 URL
  {
    const { execFn, calls } = scriptExec([{ stdout: 'Creating pull request for feature/x into main in owner/repo\n\nhttps://github.com/owner/repo/pull/42\n' }]);
    const r = await createPullRequest({ cwd: '/tmp/repo', title: 'feat: 新功能', body: '改动说明' }, execFn);
    checkOk('创建 PR 成功并解析 URL', r.ok === true && r.url === 'https://github.com/owner/repo/pull/42', r.url);
    checkOk('参数经 argv 数组传递（无 shell 注入面）',
      calls[0].cmd === 'gh'
      && calls[0].args[0] === 'pr' && calls[0].args[1] === 'create'
      && calls[0].args[2] === '--title' && calls[0].args[3] === 'feat: 新功能'
      && calls[0].args[4] === '--body' && calls[0].args[5] === '改动说明'
      && calls[0].opts.cwd === '/tmp/repo');
  }

  // 5. 标题/正文含引号与 $()：仍按字面传递（execFile argv 化，不经过 shell）
  {
    const { execFn, calls } = scriptExec([{ stdout: 'https://github.com/o/r/pull/7' }]);
    const r = await createPullRequest({ cwd: '/tmp/repo', title: 'fix: "quoted" $(touch pwned)', body: 'line1\nline2' }, execFn);
    checkOk('特殊字符标题字面传递且成功', r.ok === true && calls[0].args[3] === 'fix: "quoted" $(touch pwned)');
  }

  // 6. base 与 draft 开关
  {
    const { execFn, calls } = scriptExec([{ stdout: 'https://github.com/o/r/pull/8' }]);
    await createPullRequest({ cwd: '/tmp/repo', title: 't', base: 'develop', draft: true }, execFn);
    checkOk('--base 与 --draft 进入参数', calls[0].args.includes('--base') && calls[0].args.includes('develop') && calls[0].args.includes('--draft'));
  }
  {
    const { execFn, calls } = scriptExec([{ stdout: 'https://github.com/o/r/pull/9' }]);
    await createPullRequest({ cwd: '/tmp/repo', title: 't', base: '', draft: false }, execFn);
    checkOk('空 base / 非草稿不注入参数', !calls[0].args.includes('--base') && !calls[0].args.includes('--draft'));
  }

  // 7. 空标题本地拒绝（不发进程）
  {
    let called = false;
    const execFn = (cmd, args, opts, cb) => { called = true; cb(null, '', ''); };
    const r = await createPullRequest({ cwd: '/tmp/repo', title: '  ' }, execFn);
    checkOk('空标题拒绝且不启动 gh', r.ok === false && r.error.includes('标题') && called === false);
  }

  // 8. gh 报错透传（如未推送分支）
  {
    const { execFn } = scriptExec([{ error: new Error('exit 1'), stderr: 'X no commits between main and feature/x\n' }]);
    const r = await createPullRequest({ cwd: '/tmp/repo', title: 't' }, execFn);
    checkOk('gh 失败透传 stderr 摘要', r.ok === false && r.error.includes('no commits'), r.error);
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });

// GitHub 最小闭环（P0-E）：gh CLI 封装
// 设计取舍：依赖用户本机 gh 登录态（gh auth login），不做云端 OAuth——
// 本地优先产品不引入额外凭证面；gh 不可用时给出明确的安装/登录引导而非裸报错。
// 全部经 execFile argv 数组传参，标题/正文含引号、$()、换行均无注入面。

const { execFile } = require('child_process');

// gh 是否安装（stdout 形如 "gh version 2.62.0 (2025-...)"）
function ghAvailable(execFn = execFile) {
  return new Promise((resolve) => {
    execFn('gh', ['--version'], { timeout: 10000 }, (error, stdout) => {
      resolve(!error && /gh version/i.test(stdout || ''));
    });
  });
}

// gh 登录态（gh auth status 退出码 0 = 已登录）
function ghAuthed(execFn = execFile) {
  return new Promise((resolve) => {
    execFn('gh', ['auth', 'status'], { timeout: 15000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, detail: String((error ? stderr : stdout) || '').trim().slice(0, 500) });
    });
  });
}

// 创建 Pull Request：{ ok, url } | { ok:false, error }
// gh pr create 成功时 stdout 末行为 PR URL
function createPullRequest({ cwd, title, body = '', base = '', draft = false }, execFn = execFile) {
  return new Promise((resolve) => {
    if (!title || !String(title).trim()) { resolve({ ok: false, error: 'PR 标题不能为空' }); return; }
    const args = ['pr', 'create', '--title', String(title), '--body', String(body || '')];
    if (base && String(base).trim()) args.push('--base', String(base).trim());
    if (draft) args.push('--draft');
    execFn('gh', args, { cwd, timeout: 60000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const out = String(stdout || '').trim();
      if (error) {
        resolve({ ok: false, error: String(stderr || out || error.message || '').trim().slice(0, 500) });
        return;
      }
      const url = out.split('\n').map((l) => l.trim()).find((l) => /^https?:\/\//.test(l)) || out;
      resolve({ ok: true, url });
    });
  });
}

module.exports = { ghAvailable, ghAuthed, createPullRequest };

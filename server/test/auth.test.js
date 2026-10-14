// 全局鉴权回归测试（M6 鉴权统一加固）
// 目标：锁死 fail-closed 语义 —— 所有敏感端点必须拒绝未认证 / 非法 token / 普通用户越权访问
// 运行：node test/auth.test.js（JWT_SECRET 读 server/.env）
process.env.MJ_MINIPROGRAM_ENABLED = '1';
require('dotenv').config();
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'mj-coder-secret-key-2026-change-in-production';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[通过]' : '[失败]'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// 覆盖全部敏感路由（顺序严格对齐 src/index.js：global-models 必须最先挂载，
// 否则 models.js 的 router.use(authMiddleware) 兜底会吞掉 /global/providers 公开端点）
const routes = [
  { name: 'global-models', mod: '../src/routes/global-models' },
  { name: 'threads', mod: '../src/routes/threads' },
  { name: 'models', mod: '../src/routes/models' },
  { name: 'chat', mod: '../src/routes/chat' },
  { name: 'dashboard', mod: '../src/routes/dashboard' },
  { name: 'audit', mod: '../src/routes/audit' },
  { name: 'scheduled-tasks', mod: '../src/routes/scheduled-tasks' },
];

async function main() {
  const express = require('express');
  const app = express();
  app.use(express.json());
  // health 与静态公开端点照常放行，其余按 index.js 顺序挂载
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.use('/api/auth', require('../src/routes/auth'));
  for (const r of routes) {
    try {
      app.use('/api', require(r.mod));
    } catch (err) {
      check(`挂载路由 ${r.name}`, false, err.message);
    }
  }
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://localhost:${port}/api`;

  const userJwt = jwt.sign({ userId: 7, email: 'u@mj.dev', role: 'user' }, SECRET, { expiresIn: '1h' });
  const adminJwt = jwt.sign({ userId: 1, email: 'a@mj.dev', role: 'admin' }, SECRET, { expiresIn: '1h' });
  const badJwt = 'not.a.real.token';

  // 敏感端点矩阵：未认证必须 401
  const protected = [
    { m: 'GET', p: '/threads', label: '线程列表' },
    { m: 'POST', p: '/threads', label: '创建线程' },
    { m: 'GET', p: '/providers/secrets', label: '私有凭证' },
    { m: 'POST', p: '/chat', label: 'LLM 代理' },
    { m: 'GET', p: '/dashboard', label: '仪表盘' },
    { m: 'GET', p: '/audit', label: '审计日志' },
    { m: 'GET', p: '/scheduled-tasks', label: '定时任务' },
    { m: 'GET', p: '/global/providers/secrets', label: '全局凭证' },
  ];
  for (const ep of protected) {
    const res = await fetch(base + ep.p, { method: ep.m, headers: { 'Content-Type': 'application/json' } });
    check(`${ep.label} 未认证返回 401`, res.status === 401, `status=${res.status}`);
  }

  // 非法 token 必须 401（不得放行）
  const resBad = await fetch(`${base}/threads`, { headers: { Authorization: 'Bearer ' + badJwt } });
  check('非法 token 返回 401', resBad.status === 401, `status=${resBad.status}`);

  // 普通用户不得访问 admin 端点（403）
  const resAdmin = await fetch(`${base}/admin/global/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + userJwt },
    body: JSON.stringify({ name: 'x', base_url: 'https://x' }),
  });
  check('普通用户访问 admin 端点被拒（401/403）', resAdmin.status === 401 || resAdmin.status === 403, `status=${resAdmin.status}`);

  // 公开端点（不含 api_key）应可匿名访问：/global/providers
  const resPub = await fetch(`${base}/global/providers`);
  check('公开端点 /global/providers 允许匿名', resPub.status === 200, `status=${resPub.status}`);
  if (resPub.status === 200) {
    const body = await resPub.json();
    const providers = body.providers || body || [];
    const leaked = JSON.stringify(providers).includes('api_key');
    check('公开端点不泄露 api_key', !leaked);
  }

  // admin 端点：管理员可达（可能因参数/DB 返回 400/500，但不得是 401/403）
  const resAdminOk = await fetch(`${base}/admin/global/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminJwt },
    body: JSON.stringify({ name: 'x', base_url: 'https://example.com' }),
  });
  check('管理员不被鉴权拦截（非 401/403）', resAdminOk.status !== 401 && resAdminOk.status !== 403, `status=${resAdminOk.status}`);

  server.close();

  const failed = results.filter((x) => !x.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) { console.error('存在失败用例'); process.exit(1); }
  console.log('全局鉴权 fail-closed 回归测试全部通过');
}

main().catch((e) => { console.error('测试异常', e); process.exit(1); });
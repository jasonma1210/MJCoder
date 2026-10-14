// 微信小程序绑定链路回归测试（M5 控制面）
// 不依赖 Postgres：直接挂载 auth 路由，验证 mp-bind / mp-confirm / mp-session 全链路
// 运行：node test/mpBind.test.js（JWT_SECRET 读 server/.env）
// M6 起小程序控制面默认停用，本测试显式开启开关以复跑全链路回归
process.env.MJ_MINIPROGRAM_ENABLED = '1';
require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const authRoutes = require('../src/routes/auth');

const SECRET = process.env.JWT_SECRET || 'mj-coder-secret-key-2026-change-in-production';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[通过]' : '[失败]'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function desktopJwt(userId = 7) {
  return jwt.sign({ userId, email: 'dev@mjcode.local', role: 'user' }, SECRET, { expiresIn: '7d' });
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://localhost:${port}/api/auth`;

  // 1) mp-bind 返回绑定码 + 临时 mpToken
  let r = await fetch(base + '/mp-bind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'wx-code-1' }) });
  let b = await r.json();
  check('mp-bind 返回 bindCode 与 mpToken', r.status === 200 && !!b.bindCode && !!b.mpToken, `bindCode=${b.bindCode}`);
  const { bindCode, mpToken } = b;

  // 2) mp-confirm 无鉴权应 401
  r = await fetch(base + '/mp-confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bindCode }) });
  check('mp-confirm 未登录返回 401', r.status === 401, `status=${r.status}`);

  // 3) mp-confirm 带桌面 JWT 应 200
  r = await fetch(base + '/mp-confirm', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + desktopJwt() }, body: JSON.stringify({ bindCode }) });
  b = await r.json();
  check('mp-confirm 登录后确认成功', r.status === 200 && b.ok === true, `ok=${b.ok}`);

  // 4) mp-confirm 重复绑定码应 400（已消费）
  r = await fetch(base + '/mp-confirm', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + desktopJwt() }, body: JSON.stringify({ bindCode }) });
  check('mp-confirm 重复绑定码返回 400', r.status === 400, `status=${r.status}`);

  // 5) mp-session 凭临时 mpToken 返回正式小程序 JWT（scope=mp, userId 正确）
  r = await fetch(base + '/mp-session', { headers: { Authorization: 'Bearer ' + mpToken } });
  b = await r.json();
  let okSession = false;
  if (r.status === 200 && b.token) {
    const p = jwt.verify(b.token, SECRET);
    okSession = p.scope === 'mp' && p.userId === 7;
    check('mp-session 签发正式小程序 JWT（scope=mp, userId=7）', okSession, `scope=${p.scope}, userId=${p.userId}`);
  } else {
    check('mp-session 签发正式小程序 JWT（scope=mp, userId=7）', false, `status=${r.status}`);
  }

  // 6) mp-session 凭无效 mpToken 返回 401
  r = await fetch(base + '/mp-session', { headers: { Authorization: 'Bearer not-a-real-token' } });
  check('mp-session 无效凭证返回 401', r.status === 401, `status=${r.status}`);

  // 7) 未确认前 mp-session 返回 404（用全新绑定码验证）
  r = await fetch(base + '/mp-bind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'wx-code-2' }) });
  const b2 = await r.json();
  r = await fetch(base + '/mp-session', { headers: { Authorization: 'Bearer ' + b2.mpToken } });
  check('mp-session 桌面未确认返回 404', r.status === 404, `status=${r.status}`);

  server.close();

  const failed = results.filter((x) => !x.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) { console.error('存在失败用例'); process.exit(1); }
  console.log('M5 小程序绑定链路回归测试全部通过');
}

main().catch((e) => { console.error('测试异常', e); process.exit(1); });

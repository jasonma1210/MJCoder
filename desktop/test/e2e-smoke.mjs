// 端到端冒烟：驱动真实服务端 API 验证 M0 退出标准中服务端相关项
// 前置：服务端已启动（npm start，默认 http://localhost:3001）
const BASE = process.env.MJ_SERVER_API || 'http://localhost:3001/api';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function j(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* 非 JSON */ }
  return { status: res.status, data };
}

(async () => {
  const stamp = Date.now();
  const email = `e2e-${stamp}@mjcode.dev`;

  // 1. health
  const health = await j('GET', '/health');
  check('服务端健康检查', health.status === 200 && health.data?.status === 'ok');

  // 2. 注册
  const reg = await j('POST', '/auth/register', { email, username: `e2e${stamp}`, password: 'test123456' });
  check('注册并签发 JWT', reg.status === 200 && !!reg.data?.token, `role=${reg.data?.user?.role}`);
  const token = reg.data?.token;
  if (!token) { console.log('后续检查中止'); process.exit(1); }

  // 3. 登录
  const login = await j('POST', '/auth/login', { email, password: 'test123456' });
  check('登录', login.status === 200 && !!login.data?.token);

  // 4. 全局模型公开列表（无 Key 泄露）
  const glob = await j('GET', '/global/providers');
  check('全局模型公开列表', glob.status === 200 && Array.isArray(glob.data) && !JSON.stringify(glob.data).includes('api_key'));

  // 5. 私有 provider 创建（密文落库）
  const prov = await j('POST', '/providers', { name: `E2E-${stamp}`, base_url: 'https://api.deepseek.com/v1', api_key: 'sk-e2e-test' }, token);
  check('创建私有模型服务', prov.status === 200 && !!prov.data?.id);

  // 6. UI 列表无 Key / secrets 有 Key（结构验证）
  const list = await j('GET', '/providers', null, token);
  check('UI 列表不含 api_key', !JSON.stringify(list.data).includes('api_key'));
  const secrets = await j('GET', '/providers/secrets', null, token);
  check('secrets 接口返回解密 Key（主进程专用）', secrets.status === 200 && Array.isArray(secrets.data));
  const noAuth = await j('GET', '/providers/secrets');
  check('secrets 无 token 访问返回 401', noAuth.status === 401);

  // 7. 线程 + 消息 + token 统计
  const thread = await j('POST', '/threads', { title: 'E2E 测试对话', cwd: '/tmp' }, token);
  check('创建线程（含 cwd）', thread.status === 200 && !!thread.data?.id);
  await j('POST', `/threads/${thread.data.id}/messages`, { role: 'user', content: '你好' }, token);
  await j('POST', `/threads/${thread.data.id}/messages`, {
    role: 'assistant', content: '你好！', model_name: 'deepseek-chat',
    tokens_input: 120, tokens_output: 35,
  }, token);
  const dash = await j('GET', '/dashboard', null, token);
  check('Dashboard token 统计归真', dash.status === 200 && dash.data?.tokens_input >= 120 && dash.data?.tokens_output >= 35,
    `in=${dash.data?.tokens_input} out=${dash.data?.tokens_output}`);

  // 8. admin 403（非管理员）
  const adminTry = await j('POST', '/admin/global/providers', { name: 'x', base_url: 'y' }, token);
  check('非 admin 访问管理接口返回 403', adminTry.status === 403);

  // 9. 服务端代理管道（假 Key → 上游错误回传即证明链路通）
  const chat = await j('POST', '/chat', { providerId: prov.data.id, isGlobal: false, model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], stream: false }, token);
  check('服务端模型代理可达上游', chat.status === 401 || chat.status === 400, `status=${chat.status}`);

  // 10. 线程删除（软删）
  const del = await j('DELETE', `/threads/${thread.data.id}`, null, token);
  check('线程删除', del.status === 200 && del.data?.ok);

  // 11. 定时任务调度闭环
  const task = await j('POST', '/scheduled-tasks', { name: `E2E-${stamp}`, prompt: 'e2e 测试', schedule: '0 9 * * *' }, token);
  check('定时任务创建', task.status === 200 && !!task.data?.id);
  await j('PUT', `/scheduled-tasks/${task.data.id}`, { enabled: false }, token); // 停用避免无模型环境反复触发
  const run = await j('POST', `/scheduled-tasks/${task.data.id}/run`, null, token);
  check('定时任务手动运行（无模型优雅失败）', run.status === 502 || run.status === 200, `status=${run.status}`);
  const runs = await j('GET', `/scheduled-tasks/${task.data.id}/runs`, null, token);
  check('定时任务运行历史回写', runs.status === 200 && Array.isArray(runs.data) && runs.data.length === 1 && runs.data[0].status === 'failed');
  const taskList = await j('GET', '/scheduled-tasks', null, token);
  check('任务 last_status 回写', taskList.data?.some((t) => t.id === task.data.id && t.last_status === 'failed'));

  // 12. 审计日志
  const auditPost = await j('POST', '/audit', { action: 'shell', target: 'ls -la', detail: 'exitCode=0', approval_result: 'auto' }, token);
  check('审计上报', auditPost.status === 200 && auditPost.data?.ok);
  const auditGet = await j('GET', '/audit', null, token);
  check('审计读取', auditGet.status === 200 && auditGet.data?.some((l) => l.action === 'shell' && l.target === 'ls -la'));
  const auditNoAuth = await j('GET', '/audit');
  check('审计无 token 返回 401', auditNoAuth.status === 401);

  // 13. 清理
  await j('DELETE', `/scheduled-tasks/${task.data.id}`, null, token);
  await j('DELETE', `/providers/${prov.data.id}`, null, token);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'}：${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length > 0) { console.log('失败项：', failed.map((f) => f.name).join('；')); console.log(`（测试账户 ${email} 保留供排查，可手动清理）`); process.exit(1); }
  console.log(`（测试账户 ${email} 为脏数据，可执行：psql mjcode -c "DELETE FROM users WHERE email='${email}'"）`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });

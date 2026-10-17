// 生态连接器启动计划单测（lib/ecosystemConnectorLaunch.ts 纯函数）
// 覆盖四态：ready（直连）/ needs-config（缺变量就地引导）/ needs-auth（远程授权）/ manual（指引设置）
// 运行：node test/connector-launch.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOD = pathToFileURL(path.join(ROOT, 'renderer', 'src', 'lib', 'ecosystemConnectorLaunch.ts')).href;
const { buildLaunchPlan, remotePayload } = await import(MOD);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── remote（HTTP）──
const remoteNone = { name: 'ardot-local', transport: 'http', auth_type: 'none', install: { type: 'remote', url: 'http://127.0.0.1:50501' } };
const p1 = buildLaunchPlan(remoteNone, {});
check('remote + auth none → 直接就绪', p1.kind === 'ready' && p1.payload.url === 'http://127.0.0.1:50501' && p1.payload.transport === 'http');

const remoteOauth = { name: 'notion', transport: 'http', auth_type: 'oauth', official_url: 'https://notion.so', install: { type: 'remote', url: 'https://mcp.notion.com/mcp' } };
const p2 = buildLaunchPlan(remoteOauth, {});
check('remote + oauth 未填令牌 → needs-auth', p2.kind === 'needs-auth' && p2.missing[0].name === 'Authorization' && p2.missing[0].docs_url === 'https://notion.so');

const p3 = buildLaunchPlan(remoteOauth, { Authorization: 'Bearer tok' });
check('remote + oauth 填令牌 → 就绪并注入 header', p3.kind === 'ready' && p3.payload.headers.Authorization === 'Bearer tok');

check('remotePayload 无 url 返回 null', remotePayload({ install: { type: 'remote' } }, {}) === null);
check('remotePayload 匿名直连 headers 为空对象', remotePayload(remoteNone, {}).headers && Object.keys(remotePayload(remoteNone, {}).headers).length === 0);

// ── npm（stdio + ${VAR} 占位符）──
const lark = {
  name: 'lark-mcp', transport: 'stdio', auth_type: 'api_key',
  install: { type: 'npm', pkg: '@larksuiteoapi/lark-mcp', args: ['mcp', '-a', '${LARK_APP_ID}', '-s', '${LARK_APP_SECRET}'] },
  env_vars: [],
};
const p4 = buildLaunchPlan(lark, {});
check('npm 缺占位符 → needs-config 列出两个变量', p4.kind === 'needs-config' && p4.missing.length === 2
  && p4.missing.some((m) => m.name === 'LARK_APP_ID') && p4.missing.some((m) => m.name === 'LARK_APP_SECRET'));

const p5 = buildLaunchPlan(lark, { LARK_APP_ID: 'cli_a', LARK_APP_SECRET: 'sec_b' });
check('npm 填齐 → npx -y pkg + 占位符回填', p5.kind === 'ready'
  && p5.payload.command === 'npx'
  && p5.payload.args[0] === '-y' && p5.payload.args[1] === '@larksuiteoapi/lark-mcp'
  && p5.payload.args.includes('cli_a') && p5.payload.args.includes('sec_b')
  && !p5.payload.args.some((a) => a.includes('${')));

check('npm 部分填写仍 needs-config 且只列缺项', buildLaunchPlan(lark, { LARK_APP_ID: 'x' }).missing.length === 1);

// ── uvx / docker ──
const uvxC = { name: 'uv', transport: 'stdio', install: { type: 'uvx', pkg: 'mcp-server-uv', args: [] }, env_vars: [] };
const p6 = buildLaunchPlan(uvxC, {});
check('uvx 无缺项 → uvx pkg 直连', p6.kind === 'ready' && p6.payload.command === 'uvx' && p6.payload.args[0] === 'mcp-server-uv');

const dockerC = { name: 'd', transport: 'stdio', install: { type: 'docker', args: ['run', '-i', '--rm', 'img'] }, env_vars: [] };
const p7 = buildLaunchPlan(dockerC, {});
check('docker → docker 原样 args', p7.kind === 'ready' && p7.payload.command === 'docker' && p7.payload.args.includes('img'));

// ── env_vars 必填收集 ──
const ima = {
  name: 'ima', transport: 'stdio', auth_type: 'api_key',
  install: { type: 'manual' },
  env_vars: [{ name: 'IMA_CLIENT_ID', required: true, docs_url: 'https://ima.qq.com' }, { name: 'IMA_API_KEY', required: true }],
};
const p8 = buildLaunchPlan(ima, {});
// 2026-10-16（ima 用户实测）：manual 恒 manual——不因 required env 缺值产生 needs-config 假表单
check('manual 安装 + 必填 env 缺值 → 恒 manual（不产生假配置表单）', p8.kind === 'manual');

const envNpm = {
  name: 'e', transport: 'stdio',
  install: { type: 'npm', pkg: 'p', args: [] },
  env_vars: [{ name: 'API_KEY', required: true, label: 'API Key' }],
};
const p9 = buildLaunchPlan(envNpm, { API_KEY: 'k1' });
check('必填 env 填齐 → ready 且 env 注入 payload', p9.kind === 'ready' && p9.payload.env.API_KEY === 'k1');

// ── manual 兜底 ──
const manualC = { name: 'm', transport: 'stdio', install: { type: 'manual' }, env_vars: [] };
check('manual 无启动信息 → manual 态', buildLaunchPlan(manualC, {}).kind === 'manual');
check('npm 缺包名 → manual 兜底', buildLaunchPlan({ name: 'x', install: { type: 'npm', args: [] }, env_vars: [] }, {}).kind === 'manual');

// ── 真实目录数据：四个新连接器可被计划函数正确识别 ──
import fs from 'node:fs';
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'ecosystem', 'mcp-connectors.json'), 'utf8')).connectors;
const byId = (id) => catalog.find((c) => c.id === id);
const larkReal = byId('mcp-lark-feishu');
check('目录含飞书连接器且为 npm 占位符形态', !!larkReal && larkReal.install.type === 'npm'
  && larkReal.install.args.some((a) => a.includes('${LARK_APP_ID}')));

// 2026-10-17（用户要求）：ima 与 Ardot 从内置目录移除。
// 原来这里有两条「目录含 ima 且为 needs-auth」的断言（2026-10-16 修 manual 表单震荡时加的），
// 现在改为**反向**断言——条目不该再回来；buildLaunchPlan 的 manual / needs-auth 语义
// 已由上面 p8 / tmplOne 等内联样例覆盖，不依赖具体目录条目。
check('ima / Ardot 已从目录移除（用户 2026-10-17 要求）',
  !byId('mcp-ima') && !byId('mcp-ardot-remote') && !byId('mcp-ardot-local'));

// ── header 模板注入（2026-10-17：远程连接器「填了 key 仍 401」的根因）──
// 旧实现只认 values.Authorization；而真实连接器用 X-Api-Key / Bearer ${API_KEY} 等模板，
// 用户填的 key 注入不到对应 header → 服务端看到空 header → 恒 401，且界面显示"已配置"。
const tmplOne = {
  install: { type: 'remote', url: 'https://api.example.com/mcp', headers: { 'X-Api-Key': '${API_KEY}' } },
  env_vars: [{ name: 'API_KEY', label: 'API Key', required: true }],
  auth_type: 'api_key',
};
check('模板变量缺失 → needs-auth，且收集的是模板里的变量名（不是硬编码 Authorization）',
  (() => { const p = buildLaunchPlan(tmplOne, {}); return p.kind === 'needs-auth' && p.missing.length === 1 && p.missing[0].name === 'API_KEY'; })());
check('模板变量填齐 → ready，且注入到模板指定的 header 名',
  (() => {
    const p = buildLaunchPlan(tmplOne, { API_KEY: 'k-123' });
    return p.kind === 'ready' && p.payload.headers['X-Api-Key'] === 'k-123' && !('Authorization' in p.payload.headers);
  })());
check('Bearer 前缀模板按原样拼接（Authorization: Bearer ${API_KEY}）',
  (() => {
    const c = { install: { type: 'remote', url: 'https://a/mcp', headers: { Authorization: 'Bearer ${API_KEY}' } } };
    const p = buildLaunchPlan(c, { API_KEY: 'sk-1' });
    return p.kind === 'ready' && p.payload.headers.Authorization === 'Bearer sk-1';
  })());
check('多变量模板：缺一即 needs-auth，且只报缺的那个',
  (() => {
    const c = { install: { type: 'remote', url: 'https://a/mcp', headers: { 'X-Id': '${CLIENT_ID}', 'X-Key': '${API_KEY}' } } };
    const p = buildLaunchPlan(c, { CLIENT_ID: 'id-1' });
    return p.kind === 'needs-auth' && p.missing.length === 1 && p.missing[0].name === 'API_KEY';
  })());
check('缺变量时**不发**半截模板（发 "Bearer " 比不发更难排查）',
  (() => {
    const c = { install: { type: 'remote', url: 'https://a/mcp', headers: { Authorization: 'Bearer ${API_KEY}' } } };
    const payload = remotePayload(c, {});
    return payload && !('Authorization' in payload.headers);
  })());
check('兼容：模板未声明 Authorization 时，直接粘贴整条令牌仍可用',
  (() => {
    const c = { install: { type: 'remote', url: 'https://a/mcp' }, auth_type: 'api_key' };
    const p = buildLaunchPlan(c, { Authorization: 'Bearer pasted' });
    return p.kind === 'ready' && p.payload.headers.Authorization === 'Bearer pasted';
  })());

// ── URL 占位符（2026-10-17：把 key 放 query 的服务，如 ?token=${TUSHARE_TOKEN}）──
const urlTmpl = { install: { type: 'remote', url: 'https://api.example.com/mcp/?token=${TUSHARE_TOKEN}' }, env_vars: [{ name: 'TUSHARE_TOKEN', required: true }] };
check('URL 里的 ${VAR} 会被替换（否则发出去的是字面量，服务端只会报 401）',
  (() => {
    const p = buildLaunchPlan(urlTmpl, { TUSHARE_TOKEN: 'tk-1' });
    return p.kind === 'ready' && p.payload.url === 'https://api.example.com/mcp/?token=tk-1';
  })());
check('URL 变量缺失 → needs-auth，且收集 url 里的变量（此前只扫 headers，漏掉这类服务）',
  (() => { const p = buildLaunchPlan(urlTmpl, {}); return p.kind === 'needs-auth' && p.missing.length === 1 && p.missing[0].name === 'TUSHARE_TOKEN'; })());
check('URL 变量缺失 → remotePayload 返回 null（宁可提示缺项，也不发空 token 去请求）',
  remotePayload(urlTmpl, {}) === null);
check('headers 与 url 同时缺变量时只报缺的那个', 
  (() => {
    const c = { install: { type: 'remote', url: 'https://a/mcp?k=${K1}', headers: { 'X-K': '${K2}' } } };
    const p = buildLaunchPlan(c, { K1: 'v1' });
    return p.kind === 'needs-auth' && p.missing.length === 1 && p.missing[0].name === 'K2';
  })());

check('sse 连接器 → payload.transport=sse（否则主进程会按 streamableHttp 整错）',
  (() => {
    const c = { transport: 'sse', install: { type: 'remote', url: 'https://a/sse' } };
    const p = buildLaunchPlan(c, {});
    return p.kind === 'ready' && p.payload.transport === 'sse';
  })());
check('streamableHttp 连接器 → payload.transport=http（不回归）',
  (() => {
    const c = { transport: 'http', install: { type: 'remote', url: 'https://a/mcp' } };
    const p = buildLaunchPlan(c, {});
    return p.kind === 'ready' && p.payload.transport === 'http';
  })());

const failed = results.filter((x) => !x.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) { console.error('存在失败用例'); process.exit(1); }

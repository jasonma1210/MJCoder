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
const ardotRemote = byId('mcp-ardot-remote');
check('目录含 Ardot 远程条目且 oauth 引导授权', !!ardotRemote && buildLaunchPlan(ardotRemote, {}).kind === 'needs-auth');
const ardotLocal = byId('mcp-ardot-local');
check('目录含 Ardot 本条目且匿名直连', !!ardotLocal && buildLaunchPlan(ardotLocal, {}).kind === 'ready');
const imaReal = byId('mcp-ima');
// 2026-10-16（用户实测 ima 反馈）：manual 条目恒 manual——原实现「required env 缺值时
// 误判 needs-config，填齐后又落回 manual」造成表单震荡（保存无响应/要求重输）。
check('目录含 ima 条目且为 manual（不因 required env 误判 needs-config）', !!imaReal && buildLaunchPlan(imaReal, {}).kind === 'manual');
check('ima 填齐 env 后仍 manual（无启动信息，不产生可连接假象）', !!imaReal && buildLaunchPlan(imaReal, { IMA_CLIENT_ID: 'x', IMA_API_KEY: 'y' }).kind === 'manual');

const failed = results.filter((x) => !x.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) { console.error('存在失败用例'); process.exit(1); }

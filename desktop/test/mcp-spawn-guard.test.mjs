// MCP stdio 启动参数守卫门禁（2026-10-18 启动日志审查 ①）
//
// 背景（有日志证据的真实事故）：
//   filesystem 连接器在生态目录里声明 args: ["${ALLOWED_DIR}"]，占位符靠渲染层表单回填；
//   安装通道（npx -y <pkg>）与手工配置都不补参数，主进程也没有任何校验 →
//   服务端以「零允许目录」启动，打印 No valid root directories provided by client，
//   却仍以 14 个工具回报「连接成功」：界面健康、工具全废（静默失败）。
//
// 本套件锁三件事：
//   ① 未替换占位符（命令行/参数/env）一律拒绝，且错误信息含占位符名与修复指引；
//   ② 空参数一律拒绝（它是占位符替换落空的典型残留）；
//   ③ 合法参数放行 + 源码门禁：connectMcpServer 必须调用守卫（防被摘掉导致静默失败回归）。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const { checkStdioSpawn } = require(path.join(ROOT, 'main/mcpSpawnGuard.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── ① 未替换占位符 ──
{
  const r1 = checkStdioSpawn({ name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '${ALLOWED_DIR}'] });
  check('参数里的未替换占位符被拒', r1.ok === false, r1.error || '');
  check('错误信息点名占位符（便于用户知道该填哪项）', /ALLOWED_DIR/.test(r1.error || ''));
  check('错误信息给出可行动指引（指向生态中心重新配置）', /生态中心/.test(r1.error || ''));

  const r2 = checkStdioSpawn({ name: 'x', command: 'npx', args: ['-y', '${PKG}'] });
  check('命令后参数的占位符同样被拒', r2.ok === false);

  const r3 = checkStdioSpawn({ name: 'x', command: '${BIN}', args: [] });
  check('命令本身是占位符时被拒', r3.ok === false);

  const r4 = checkStdioSpawn({ name: 'x', command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: '${API_KEY}' } });
  check('env 值里的占位符被拒（避免带半截模板去请求）', r4.ok === false && /API_KEY/.test(r4.error || ''));
}

// ── ② 空参数 ──
{
  const r1 = checkStdioSpawn({ name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', ''] });
  check('空参数被拒（占位符替换落空的典型残留）', r1.ok === false, r1.error || '');
  const r2 = checkStdioSpawn({ name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '   '] });
  check('纯空白参数同样被拒', r2.ok === false);
}

// ── ③ 合法配置放行 ──
{
  const r1 = checkStdioSpawn({ name: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] });
  check('无参数的标准 npx 服务放行', r1.ok === true, r1.error || '');
  const r2 = checkStdioSpawn({ name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/x/work'] });
  check('已填真实目录的 filesystem 放行', r2.ok === true, r2.error || '');
  const r3 = checkStdioSpawn({ name: 'x', command: 'uvx', args: ['pkg', '--flag=1'] });
  check('uvx 与带 = 的普通参数放行', r3.ok === true);
  const r4 = checkStdioSpawn({ name: 'x', command: 'docker', args: ['run', '-i', '--rm', 'mcp/x'] });
  check('docker 参数放行', r4.ok === true);
}

// ── ④ 源码门禁：守卫必须真的挂在连接入口上 ──
{
  const src = fs.readFileSync(path.join(ROOT, 'main/ipc/mcp.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
  check('connectMcpServer 调用 checkStdioSpawn（静默失败不再回归）', src.includes('checkStdioSpawn('));
  const pluginsSrc = fs.readFileSync(path.join(ROOT, 'main/ipc/plugins.js'), 'utf8');
  check('安装通道经注入的 connectMcpServer 进入同一守卫（不另开 spawn 分支）',
    pluginsSrc.includes('getConnectMcpServer'));
  // 安装通道只按包名 npx 启动、不带连接器声明的参数——必须对「声明了必填参数的连接器」提前拒绝，
  // 否则 filesystem 类服务仍会零配置启动并回报 14 个工具（静默假健康）。
  check('安装通道对需配置的连接器提前拒绝（needsConfig 引导去生态中心）',
    pluginsSrc.includes('connectorRequiresConfig(') && /needsConfig:\s*true/.test(pluginsSrc));
}

console.log(`\nmcp-spawn-guard: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);

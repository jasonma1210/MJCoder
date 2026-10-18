// 2026-10-18 门禁：MCP stdio 子进程 stderr 分级降噪（启动日志噪音治理）
//
// 背景：MCP 服务端常把 info/debug 级日志写到 stderr（如 desktop-commander 的 info/debug），
//   旧实现把 stderr **全量**经 onLog 转发，于是「启动重连 N 个服务」的日志被信息级噪音淹没，
//   真实告警（崩溃 / 拒绝 / 找不到可执行文件）反而不显眼。
//
// 本套件锁三件事：
//   ① warn/error 家族词与堆栈行**必须**透传（降噪不能把告警一起丢）；
//   ② 纯 info/debug 噪音**默认**不透传；
//   ③ MJCODE_MCP_VERBOSE 置位时放开全量（排查开关）。
// 另加源码门禁：mcpClient.js 的 stdio 分支必须装配 dispatch 且不得再直接 require child_process.spawn。
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const { shouldForwardStderr } = require(path.join(ROOT, 'main/mcpStdioTransport.js'));
const { shouldForwardLogLevel, handleServerMessage } = require(path.join(ROOT, 'main/mcpClient.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── ① 告警必须透传 ──
{
  const must = [
    'Error: spawn npx ENOENT',
    '[error] command failed',
    'WARN: deprecated config',
    'warning: unknown project config',
    'fatal: not a git repository',
    'Exception in thread main',
    'EACCES: permission denied',
    'connection refused',
    '    at Object.<anonymous> (/x/y.js:1:1)',
    'resource not found',
  ];
  for (const line of must) {
    delete process.env.MJCODE_MCP_VERBOSE;
    check(`告警透传：${JSON.stringify(line.slice(0, 40))}`, shouldForwardStderr(line) === true);
  }
}

// ── ② 噪音默认不透传 ──
{
  delete process.env.MJCODE_MCP_VERBOSE;
  const noisy = [
    'info: server started',
    '[info] listening on 3000',
    'debug: heartbeat ok',
    '[debug] cache hit',
    'Starting MCP server',
    'initialized',
  ];
  for (const line of noisy) {
    check(`噪音不透传：${JSON.stringify(line)}`, shouldForwardStderr(line) === false);
  }
}

// ── ③ 排查开关放开全量 ──
{
  process.env.MJCODE_MCP_VERBOSE = '1';
  check('MJCODE_MCP_VERBOSE=1 时不透传的噪音也放行', shouldForwardStderr('debug: heartbeat ok') === true);
  delete process.env.MJCODE_MCP_VERBOSE;
  check('开关未置位时回到默认降噪', shouldForwardStderr('debug: heartbeat ok') === false);
}

// ── ⑤ notifications/message 通道按 level 分流（与 stderr 是两条独立通道）──
// 真实证据：desktop-commander 把自己 12 行启动日志**经 MCP logging 通知**发来，
// 报头就是 `[info] Enhanced FilteredStdioServerTransport initialized` 这一形。
// 只过滤 stderr 挡不住它——必须对 notifications/message 也做 level 分流。
{
  delete process.env.MJCODE_MCP_VERBOSE;
  const kept = ['warning', 'error', 'critical', 'alert', 'emergency'];
  for (const lv of kept) {
    check(`notifications/message 透传 ${lv} 级`, shouldForwardLogLevel(lv) === true);
  }
  for (const lv of ['debug', 'info', 'notice', undefined, '']) {
    check(`notifications/message 默认丢弃 ${JSON.stringify(lv)} 级`, shouldForwardLogLevel(lv) === false);
  }
  process.env.MJCODE_MCP_VERBOSE = '1';
  check('MJCODE_MCP_VERBOSE=1 时 info/debug 也放行', shouldForwardLogLevel('debug') === true && shouldForwardLogLevel('info') === true);
  delete process.env.MJCODE_MCP_VERBOSE;

  // 端到端：一条 info 通知不得产生任何 onLog 输出；一条 error 通知必须产出。
  const logs = [];
  const fake = { name: 'dc', transport: { send: async () => {} } };
  const hook = { onLog: (l) => logs.push(l) };
  handleServerMessage(fake, { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'Loaded 5 feature flags from cache' } }, hook);
  check('info 级通知端到端不落日志（desktop-commander 噪音消失）', logs.length === 0, `出站 ${logs.length} 条`);
  handleServerMessage(fake, { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'error', data: 'server crashed' } }, hook);
  check('error 级通知端到端照常落日志（告警不丢）', logs.length === 1 && /server crashed/.test(logs[0]), JSON.stringify(logs));
}

// ── ④ 源码门禁：stdio 分支装配正确 ──
{
  const client = fs.readFileSync(path.join(ROOT, 'main/mcpClient.js'), 'utf8');
  check('mcpClient 经 dispatch 注入调用 createStdioTransport',
    /createStdioTransport\(\{[^)]*dispatch:\s*dispatchMessage/.test(client));
  check('mcpClient 不再直接持有 child_process.spawn（已归 mcpStdioTransport）',
    !/require\(\s*'child_process'\s*\)/.test(client));
  const stdio = fs.readFileSync(path.join(ROOT, 'main/mcpStdioTransport.js'), 'utf8');
  check('mcpStdioTransport 已接入 stderr 分级过滤', /shouldForwardStderr\(text\)/.test(stdio));
}

console.log(`\nmcp-stderr-filter: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);

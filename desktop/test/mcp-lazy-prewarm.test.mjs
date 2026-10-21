// 期 1（2026-10-18）门禁：MCP 懒启动地基——预热白名单 / 灰度开关 / 工具清单缓存
//
// 背景：MCP 两层权限模型落地第一期。默认「全量 spawn 已保存服务」改为可灰度的「只拉起预热白名单」，
//   其余服务按需唤起。直接前提是**工具清单缓存**——否则懒启动后未连接服务的工具对模型不可见。
//
// 本套件锁四件事：
//   ① 预热白名单只含 time / fetch（A-04：filesystem 已移出）；git / playwright / desktop-commander / 付费检索一律排除；
//   ② tier 分级开关默认**开启**（G2+N8：懒启动不再依赖 MJCODE_MCP_LAZY，仅显式 0/false/off 关闭）；
//   ③ 工具清单缓存读写闭环 + 损坏时 fail-open（不阻塞启动）；
//   ④ 源码门禁：reconnectMcpServers 必须经 isLazyMode/selectPrewarm 分流；
//      callMcpTool 必须有按需连接兜底；mcp:listTools 只回已连接服务（D1：不再合并未连接的缓存清单）。
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const { isLazyMode, isPrewarmTarget, selectPrewarm } = require(path.join(ROOT, 'main/mcpPrewarm.js'));
const { createMcpToolCache, slimTools } = require(path.join(ROOT, 'main/mcpToolCache.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── ① 预热白名单：入选与排除 ──
{
  const inside = [
    { name: 'time', command: 'uvx', args: ['mcp-server-time'] },
    { name: 'fetch', command: 'uvx', args: ['mcp-server-fetch'] },
  ];
  for (const c of inside) check(`白名单入选：${c.name}`, isPrewarmTarget(c) === true);
  const outside = [
    // A-04 收口：filesystem 移出 auto-start（原生文件工具已覆盖），回落 whitelist
    { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/x'] },
    { name: 'git', command: 'uvx', args: ['mcp-server-git', '--repository', '/x'] },
    { name: 'git-mcp', transport: 'http', url: 'https://gitmcp.io/docs' },
    { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'] },
    { name: 'desktop-commander', command: 'npx', args: ['-y', '@wonderwhy-er/desktop-commander'] },
    { name: 'tavily', command: 'npx', args: ['-y', 'tavily-mcp'] },
    { name: 'context7', transport: 'http', url: 'https://mcp.context7.com/mcp' },
    { name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
    { name: 'deepwiki', transport: 'http', url: 'https://mcp.deepwiki.com/mcp' },
  ];
  for (const c of outside) check(`白名单排除：${c.name}`, isPrewarmTarget(c) === false);
}

// ── ①b 重命名兜底：按启动包名判定，白名单不因自定义 name 失效 ──
{
  check('重命名兜底（npm 包名）',
    isPrewarmTarget({ name: 'my-fs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/x'] }) === false);
  check('重命名兜底（uvx 包名）',
    isPrewarmTarget({ name: '本地时间', command: 'uvx', args: ['mcp-server-time'] }) === true);
}

// ── ①c selectPrewarm 只保留白名单子集 ──
{
  const all = [
    { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/x'] },
    { name: 'git', command: 'uvx', args: ['mcp-server-git'] },
    { name: 'time', command: 'uvx', args: ['mcp-server-time'] },
    { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'] },
    { name: 'fetch', command: 'uvx', args: ['mcp-server-fetch'] },
  ];
  const picked = selectPrewarm(all).map((c) => c.name);
  check('selectPrewarm 结果 = time/fetch（A-04：filesystem 已移出）', JSON.stringify(picked) === JSON.stringify(['time', 'fetch']), picked.join(','));
  check('selectPrewarm 非数组入参安全', Array.isArray(selectPrewarm(null)) && selectPrewarm(null).length === 0);
}

// ── ② tier 分级开关：默认开启，仅显式 0/false/off 关闭（G2+N8）──
{
  const on = ['', undefined, '  ', '1', 'true', 'TRUE', 'yes', 'on'];
  for (const v of on) check(`懒启动默认开启：MJCODE_MCP_LAZY=${JSON.stringify(v)}`, isLazyMode({ MJCODE_MCP_LAZY: v }) === true);
  const off = ['0', 'false', 'FALSE', 'off', 'OFF'];
  for (const v of off) check(`懒启动显式关闭：MJCODE_MCP_LAZY=${JSON.stringify(v)}`, isLazyMode({ MJCODE_MCP_LAZY: v }) === false);
  check('缺省 env（无该键）默认开启（tier 分级生效）', isLazyMode({}) === true);
}

// ── ③ 工具清单缓存：读写闭环 + fail-open ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-mcptc-'));
  const file = path.join(dir, 'mcp-tool-manifests.json');
  const cache = createMcpToolCache({ filePath: file, log: () => {} });

  check('无文件时 loadAll 返回空对象', Object.keys(cache.loadAll()).length === 0);
  check('无缓存时 getManifest 返回 null', cache.getManifest('filesystem') === null);

  // slimTools：只留 name/description/inputSchema，剔除无关字段与非法项
  const slim = slimTools([
    { name: 'read_file', description: 'read', inputSchema: { type: 'object' }, extra: 'x' },
    { description: 'no-name' },
    null,
  ]);
  check('slimTools 只留三字段且剔除非法项', slim.length === 1 && slim[0].name === 'read_file' && !('extra' in slim[0]));

  await cache.saveManifest('filesystem', [{ name: 'read_file', description: 'read a file', inputSchema: { type: 'object', properties: {} } }]);
  const mf = cache.getManifest('filesystem');
  check('saveManifest → getManifest 闭环', mf && mf.tools.length === 1 && mf.tools[0].name === 'read_file' && typeof mf.updatedAt === 'number');

  // 并发写：写盘串行化，两个服务都不丢
  await Promise.all([
    cache.saveManifest('time', [{ name: 'get_current_time', description: 't' }]),
    cache.saveManifest('fetch', [{ name: 'fetch', description: 'f' }]),
  ]);
  const all = cache.loadAll();
  check('并发写不互相覆盖（三服务齐全）', ['filesystem', 'time', 'fetch'].every((n) => all[n] && all[n].tools.length === 1), Object.keys(all).join(','));

  await cache.removeManifest('time');
  check('removeManifest 生效', cache.getManifest('time') === null && cache.getManifest('fetch') !== null);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ③b 损坏文件 fail-open（不阻塞启动）──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-mcptc2-'));
  const file = path.join(dir, 'mcp-tool-manifests.json');
  fs.writeFileSync(file, '{ this is not json');
  const cache = createMcpToolCache({ filePath: file, log: () => {} });
  check('损坏文件读取 fail-open（返回空对象不抛错）', Object.keys(cache.loadAll()).length === 0);
  await cache.saveManifest('ok', [{ name: 'x', description: '' }]);
  check('损坏文件可被后续写入修复', cache.getManifest('ok') !== null);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ④ 源码门禁：懒启动分流 / 按需兜底 / 缓存合并已接线 ──
{
  const ipc = fs.readFileSync(path.join(ROOT, 'main/ipc/mcp.js'), 'utf8');
  check('reconnectMcpServers 经 isLazyMode 分流', /const lazy = isLazyMode\(\)/.test(ipc));
  // 期 2：白名单子集由 selectPrewarm 升级为「三层分级 + profile 分流」的 autoStartConfigs
  check('reconnectMcpServers 经 autoStartConfigs(all,{profile}) 取自动启动子集', /lazy \? autoStartConfigs\(all, \{ profile \}\) : all/.test(ipc));
  check('治理档位经 getGovernance().profile 注入', /const profile = getGovernance\(\)\.profile/.test(ipc));
  check('callMcpTool 有按需连接兜底（connect-on-demand）', /reason: 'connect-on-demand'/.test(ipc));
  // D1（2026-10-20）：listTools 只回「已连接」服务——不得再用未连接的缓存清单兜底，
  // 否则渲染层会把全部已保存 MCP 工具注入每条对话、并使意图动态加载沦为空操作。
  {
    // 切片边界必须取「listTools 之后的下一个 ipcMain.handle」——
    // 不能拿 indexOf("mcp:getConfig")，因为该串在更早的注释里也出现过（L314），
    // 会让 ltEnd < ltStart、切片为空、断言恒假（假失败）。
    const ltStart = ipc.indexOf("mcp:listTools");
    const ltNext = ipc.indexOf('ipcMain.handle(', ltStart + 1);
    const ltBody = ltStart >= 0 ? ipc.slice(ltStart, ltNext > ltStart ? ltNext : ipc.length) : '';
    check('mcp:listTools 只回已连接服务（不再合并未连接缓存清单）',
      ltBody.includes("mcp:listTools") && !/getToolCache\(\)\.getManifest/.test(ltBody) && !/loadMcpConfig\(\)/.test(ltBody));
  }
  check('连接成功后落工具清单缓存', /getToolCache\(\)\.saveManifest\(name, tools\)/.test(ipc));
  check('断开时清理工具清单缓存', /getToolCache\(\)\.removeManifest\(name\)/.test(ipc));
  // 期 2：连接成功落盘打 tier；getConfig 下发 governance
  check('连接成功落盘打 tier（classifyTier）', /const tier = classifyTier\(\{ name, command, args, url \}\)/.test(ipc));
  check('mcp:getConfig 下发 governance', /governance: getGovernance\(\)/.test(ipc));
  check('治理读写 IPC 已注册', /'mcp:governance\/get'/.test(ipc) && /'mcp:governance\/set'/.test(ipc));
}

console.log(`\nmcp-lazy-prewarm: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);

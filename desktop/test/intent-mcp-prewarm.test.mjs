// v1（2026-10-19）门禁：意图驱动的 MCP 动态加载（原生优先）
//
// 背景：用户诉求「按对话意图动态拉起对应 MCP 连接器」。硬规则三条：
//   ① 原生优先——本地原生工具已覆盖的能力（docx/xlsx/pptx/pdf/web/browser/code）绝不拉 MCP，
//      同一次 run 内两套实现永不同框（从根上避免冲突）；
//   ② 只连用户**已保存**的连接器，本机制不新建任何 MCP 服务；
//   ③ 离线规则词典判定（不调模型）。
//
// 本套件锁两件事：
//   A. 纯函数行为：意图判定 / 原生优先过滤 / 连接器匹配（名字别名 + 工具签名兜底）/ 定义合并；
//   B. 源码接线：agentRunner 在组装 engineParams 之前有界预热并合并进 mcpTools、main.js 注入
//      mcpDynamic、ipc/mcp.js 导出所需三个入口。
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const {
  detectCapabilities, nonNativeCapabilities, selectServersToPrewarm,
  planPrewarm, toToolDefs, mergeToolDefs,
} = require(path.join(ROOT, 'main/intentMcpPrewarm.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── A1. 意图判定：命中的能力键 ──
{
  const keys = (t) => detectCapabilities(t).map((c) => c.key);
  check('识出 Excel/预算 → xlsx', keys('帮我做一份 Excel 预算表').includes('xlsx'), keys('帮我做一份 Excel 预算表').join(','));
  check('识出 PPT/演示文稿 → pptx', keys('输出一份 PPT 演示文稿').includes('pptx'));
  check('识出 Word/说明书 → docx', keys('生成 Word 说明书').includes('docx'));
  check('识出 PDF/打印 → pdf', keys('导出成一页 PDF').includes('pdf'));
  check('识出联网搜索 → web', keys('联网搜索一下最新消息').includes('web'));
  check('识出生成图片 → imagegen', keys('帮我生成图片').includes('imagegen'));
  check('识出 notion → notion', keys('把需求写进 notion 知识库').includes('notion'));
  check('纯闲聊不误命中能力', detectCapabilities('今天天气不错').length === 0, String(detectCapabilities('今天天气不错').length));
  check('空文本返回空', detectCapabilities('').length === 0 && detectCapabilities(null).length === 0);
}

// ── A2. 原生优先：已覆盖的能力被过滤（含「同名连接器也在场」也不拉）──
{
  const caps = detectCapabilities('生成 PPT 演示文稿');
  check('原生优先：pptx 能力被过滤', nonNativeCapabilities(caps).length === 0);
  // 即使存在一个名字就叫 pptx-mcp 的已保存连接器，也不应被拉起——证明是「能力原生覆盖」在起作用，
  // 而不是「目录里恰好没有匹配的连接器」。
  const saved = [{ name: 'pptx-mcp' }, { name: 'mcp-excel' }];
  const servers = selectServersToPrewarm({ capabilities: caps, savedConfigs: saved, manifests: {} });
  check('原生优先：文档类诉求不拉起任何 MCP 连接器', servers.length === 0, servers.join(','));

  const plan = planPrewarm('帮我做一份 Excel 报表', saved, {});
  check('planPrewarm：文档诉求 capabilities 已识别但 servers 为空',
    plan.capabilities.includes('xlsx') && plan.servers.length === 0, JSON.stringify(plan));
}

// ── A3. 未原生覆盖：按服务名别名匹配 ──
{
  const caps = detectCapabilities('帮我生成图片');
  const servers = selectServersToPrewarm({ capabilities: caps, savedConfigs: [{ name: 'replicate' }], manifests: {} });
  check('未覆盖能力按服务名别名匹配（replicate）', servers.length === 1 && servers[0] === 'replicate', servers.join(','));
}

// ── A4. 未原生覆盖：用户自定义命名时按工具签名兜底匹配 ──
{
  const caps = detectCapabilities('把这次会议记录写进 notion');
  const saved = [{ name: 'my-notes' }]; // 名字不含 notion，靠工具清单签名兜底
  const manifests = { 'my-notes': [{ name: 'append_block', description: 'write a block into your Notion knowledge base' }] };
  const servers = selectServersToPrewarm({ capabilities: caps, savedConfigs: saved, manifests });
  check('自定义命名连接器按工具签名兜底匹配', servers.length === 1 && servers[0] === 'my-notes', servers.join(','));
}

// ── A5. 混合诉求：原生能力跳过、非原生能力照常拉起 ──
{
  const caps = detectCapabilities('出一份 PPT，并先从 notion 取资料');
  const servers = selectServersToPrewarm({
    capabilities: caps,
    savedConfigs: [{ name: 'notion' }, { name: 'pptx-mcp' }],
    manifests: {},
  });
  check('混合诉求只拉起非原生能力对应的连接器', servers.length === 1 && servers[0] === 'notion', servers.join(','));
}

// ── A6. 工具定义构造与合并（按 function.name 去重、base 优先）──
{
  const defs = toToolDefs('replicate', [{ name: 'generate_image', description: 'gen', inputSchema: { type: 'object' } }]);
  check('toToolDefs：名字前缀 mcp__server__tool', defs[0].function.name === 'mcp__replicate__generate_image', defs[0].function.name);
  check('toToolDefs：parameters 缺省回落空对象', toToolDefs('s', [{ name: 'x' }])[0].function.parameters.type === 'object');

  const base = [{ type: 'function', function: { name: 'mcp__a__t' } }];
  const add = [{ type: 'function', function: { name: 'mcp__a__t' } }, { type: 'function', function: { name: 'mcp__b__u' } }];
  const merged = mergeToolDefs(base, add);
  check('mergeToolDefs：同名去重', merged.length === 2, String(merged.length));
  check('mergeToolDefs：base 优先（首项来自 base）', merged[0] === base[0]);
  check('mergeToolDefs：无 function.name 的条目被丢弃', mergeToolDefs([{ type: 'function' }], []).length === 0);
}

// ── B. 源码接线门禁 ──
{
  const runner = fs.readFileSync(path.join(ROOT, 'main/agentRunner.js'), 'utf8');
  check('agentRunner 引入 intentMcpPrewarm', runner.includes("require('./intentMcpPrewarm')"));
  const iAwait = runner.indexOf('await intentPrewarmToolDefs(payload)');
  const iParams = runner.indexOf('const engineParams = {');
  check('预热发生在组装 engineParams 之前', iAwait > 0 && iParams > 0 && iAwait < iParams, `await@${iAwait} params@${iParams}`);
  check('mcpTools 经 mergeToolDefs 合并', runner.includes('intentMcp.mergeToolDefs(payload.mcpTools || [], dynamicMcpTools)'));
  check('预热失败 fail-open（不抛错阻塞 run）', runner.includes('意图预热 MCP 连接失败（fail-open'));

  const main = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8');
  check('main.js 注入 mcpDynamic 依赖', main.includes('mcpDynamic: {') && main.includes('reconnectSaved: (name) => mcpIpc.reconnectSaved'));
  check('main.js 只读已保存配置 + 工具清单缓存', main.includes('mcpIpc.loadMcpConfig()') && main.includes('mcpIpc.getToolCache().getManifest(name)'));

  const mcp = fs.readFileSync(path.join(ROOT, 'main/ipc/mcp.js'), 'utf8');
  check('ipc/mcp.js 导出 reconnectSaved/loadMcpConfig/getToolCache',
    mcp.includes('reconnectSaved, loadMcpConfig, getToolCache,'));
  check('reconnectSaved 已连接分支回带 tools', mcp.includes('tools: existing.tools || []'));
}

console.log(`\nintent-mcp-prewarm: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);

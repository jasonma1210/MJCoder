// 第八轮审查 F-005 / B1-B-05 门禁：MCP 工具名「拼名 / 反解」必须严格互逆
//
// 缺陷（改前，确定性复现）：
//   拼名 `mcp__${server}__${tool}`（shared/mcpToolDefs.mjs）
//   反解 `name.split('__')` → `parts[1]` / `parts.slice(2).join('__')`（agent-core/index.js）
//   二者不是逆函数。server=`my__svc`, tool=`x` → `mcp__my__svc__x`
//   → `split('__')` = ['mcp','','my','svc','x'] → **server=`my` / tool=`svc__x`**
//   结果：工具调用被静默路由到另一个（多半不存在）的服务，全程无报错。
//   入口（main/ipc/mcp.js）此前只校验 name ≤ 120 字符，不校验字符集 → 用户可自由踩中。
//
// 本套件锁六件事：
//   ① 编解码往返：`decodeToolName(buildToolName(s, t))` 对含 `__`/空格/中文/`%` 的服务名逐一还原；
//   ② **安全名零迁移**：`filesystem`/`time`/`fetch` 的编码片段与原文逐字节相同 —— 存量配置无需迁移；
//   ③ 端到端反例回归：`my__svc` 必须解回 `{server:'my__svc'}`，并显式对照旧实现的错误解；
//   ④ 旧格式兼容：`mcp__filesystem__read`（改前产出的名字）仍能反解，不因「无 `%`」被拒；
//   ⑤ 结构健壮性：非 mcp 名 / 缺分隔符 / 空服务名 / 空工具名 → `null`，不抛异常；
//   ⑥ 接线校验：`toToolDefs` 产出的 name 真的走 codec（不是只测 codec 自己不测调用点），
//      且 agent-core 的反解点不得再出现 `split('__')`。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

const {
  encodeServerSegment, decodeToolName, buildToolName, isEncodedNameSafe,
  MAX_ENCODED_FULL_NAME_CHARS,
} = await import(path.join(ROOT, 'shared/mcpNameCodec.mjs'));
const { toToolDefs } = await import(path.join(ROOT, 'shared/mcpToolDefs.mjs'));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`✅ ${name}`);
    pass++;
  } catch (e) {
    console.log(`❌ ${name}\n   ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  }
}
const eq = (a, b, msg) => assert.deepEqual(a, b, `${msg || ''} 实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`);
async function acheck(name, fn) {
  total++;
  try {
    await fn();
    console.log(`✅ ${name}`);
    pass++;
  } catch (e) {
    console.log(`❌ ${name}\n   ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  }
}

// ── ① 编解码往返（含 `__` / 空格 / 中文 / `%` 的服务名逐一断言） ──
const ROUNDTRIP = ['my__svc', 'a__b__c', '中文 服务', 'normal', 'x', 'has space', '%weird%'];
for (const s of ROUNDTRIP) {
  check(`① encode→decode 往返可逆：${JSON.stringify(s)}`, () => {
    eq(decodeToolName(buildToolName(s, 't')), { server: s, tool: 't' });
    // 片段级往返（不经工具名）
    eq(decodeToolName(`mcp__${encodeServerSegment(s)}__t`)?.server, s);
  });
}

check('①b 编码片段只含 [A-Za-z0-9-] 与 %XX（绝不含 `_`，故分隔符唯一）', () => {
  for (const s of ROUNDTRIP.concat(['中文', '__', '_', '%', ' a ', '服务 v2'])) {
    const seg = encodeServerSegment(s);
    assert.match(seg, /^(?:[A-Za-z0-9-]|%[0-9A-F]{2})*$/, `片段非法（${s}）：${seg}`);
    assert.ok(!seg.includes('_'), `片段含下划线（${s}）：${seg}`);
    eq(decodeToolName(buildToolName(s, 't'))?.server, s);
  }
});

check('①c `_` 被转义为 %5F、`%` 被转义为 %25、空格为 %20', () => {
  eq(encodeServerSegment('a_b'), 'a%5Fb');
  eq(encodeServerSegment('a%b'), 'a%25b');
  eq(encodeServerSegment('a b'), 'a%20b');
  eq(encodeServerSegment('%5F'), '%255F'); // 字面量 %5F 与「编码后的 _」不再混淆
  eq(decodeToolName(buildToolName('%5F', 't'))?.server, '%5F');
});

// ── ② 安全名零迁移（硬约束：存量配置/缓存逐字节不变） ──
check('② 安全名零迁移：filesystem / time / fetch 编码片段与原名逐字节相同', () => {
  for (const s of ['filesystem', 'time', 'fetch', 'github', 'ima-mcp', 'v2', 'A-B_9'.replace('_', '-')]) {
    eq(encodeServerSegment(s), s, `安全名被改写：${s}`);
    eq(buildToolName(s, 'read'), `mcp__${s}__read`, `安全名拼名被改写：${s}`);
  }
});

// ── ③ 端到端反例回归（本次修复的核心证据） ──
check('③ server 含 `__` 的端到端反例：my__svc 必须解回 {server:"my__svc", tool:"x"}', () => {
  const full = buildToolName('my__svc', 'x');
  eq(full, 'mcp__my%5F%5Fsvc__x', '拼名形状变了');
  eq(decodeToolName(full), { server: 'my__svc', tool: 'x' });

  // ⚠ 旧实现（`name.split('__')` + parts[1]）在同一名字上的结果 —— 这就是 F-005 本体：
  //   parts = ['mcp','','my','svc','x'] → server='my'、tool='svc'+'__'+'x' = 'svc__x'
  //   → 调用被打到「my」这个（多半不存在的）服务上，而真实服务 my__svc 永远收不到调用。
  const oldParts = 'mcp__my__svc__x'.split('__');
  eq({ server: oldParts[1], tool: oldParts.slice(2).join('__') }, { server: 'my', tool: 'svc__x' },
    '旧实现的错误解应为 {server:"my", tool:"svc__x"}');
  // 新实现对同一个**已修复**的名字绝不能再产出旧解
  assert.notDeepEqual(decodeToolName(full), { server: 'my', tool: 'svc__x' }, '仍退化为旧行为');
});

check('③b a__b__c / 连续三段 `__` 不产生二次切分', () => {
  eq(decodeToolName(buildToolName('a__b__c', 'y')), { server: 'a__b__c', tool: 'y' });
  eq(decodeToolName(buildToolName('__', '__')), { server: '__', tool: '__' });
});

// ── ④ 旧格式兼容（改前产出的名字必须还能解） ──
check('④ 旧格式兼容：mcp__filesystem__read → {server:"filesystem", tool:"read"}', () => {
  eq(decodeToolName('mcp__filesystem__read'), { server: 'filesystem', tool: 'read' });
  eq(decodeToolName('mcp__time__now'), { server: 'time', tool: 'now' });
});

check('④b 旧格式含 `_` 与「看似编码实则字面量」的片段按字面量返回，不被拒绝', () => {
  eq(decodeToolName('mcp__my_svc__x'), { server: 'my_svc', tool: 'x' });
  eq(decodeToolName('mcp__%weird%__x'), { server: '%weird%', tool: 'x' });
  eq(decodeToolName('mcp__中文 服务__x'), { server: '中文 服务', tool: 'x' });
});

// ── ⑤ 工具名含 `__` / 结构非法 ──
check('⑤ 工具名含 `__` 不歧义：buildToolName("s","a__b") 反解出 tool==="a__b"', () => {
  eq(decodeToolName(buildToolName('s', 'a__b')), { server: 's', tool: 'a__b' });
  eq(decodeToolName(buildToolName('s', '__')), { server: 's', tool: '__' });
});

check('⑤b 非 mcp 前缀 / 结构非法 → null（不抛异常）', () => {
  for (const bad of ['read_file', 'mcp', 'mcp_', '', null, undefined, 0]) {
    eq(decodeToolName(bad), null, `应返回 null：${String(bad)}`);
  }
  for (const bad of ['mcp__', 'mcp__x', 'mcp__x__', 'mcp____x', 'mcp____']) {
    eq(decodeToolName(bad), null, `结构非法应返回 null：${bad}`);
  }
});

// ── ⑥ 接线校验（codec 之外，锁住真正的调用点） ──
check('⑥ toToolDefs 真的走 codec：含 `__` 的服务名产出可唯一反解的工具名', () => {
  const defs = toToolDefs('my__svc', [{ name: 'x', description: 'd' }, { name: 'a__b' }]);
  eq(defs.length, 2);
  eq(decodeToolName(defs[0].function.name), { server: 'my__svc', tool: 'x' });
  eq(decodeToolName(defs[1].function.name), { server: 'my__svc', tool: 'a__b' });
  // 安全名仍逐字节保持旧形状（零迁移）
  eq(toToolDefs('filesystem', [{ name: 'read' }])[0].function.name, 'mcp__filesystem__read');
});

check('⑥b 三处调用点不得再裸拆工具名（split("__") 回归锁）', () => {
  const sites = [
    'agent-core/index.js', // 反解 → mcpCallTool
    'main/agentRunner.js', // 反解 → 意图预热 already 集合
    'renderer/src/components/ChatArea.jsx', // 反解 → UI connectedServers
  ];
  for (const rel of sites) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!src.includes("split('__')") && !src.includes('split("__")'),
      `${rel} 仍存在 split("__") 裸拆工具名 —— F-005 回归`);
    assert.ok(src.includes('mcpNameCodec.mjs'), `${rel} 未接入 shared/mcpNameCodec.mjs`);
  }
  assert.ok(fs.readFileSync(path.join(ROOT, 'agent-core/index.js'), 'utf8').includes('decodeToolName'),
    'agent-core 未调用 decodeToolName');
});

check('⑥c mcpToolDefs 不得再手写拼名模板（必须调 buildToolName）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared/mcpToolDefs.mjs'), 'utf8');
  assert.ok(!/name:\s*`mcp__\$\{/.test(src), 'mcpToolDefs.mjs 仍手写 `mcp__${...}__${...}`');
  assert.ok(src.includes("from './mcpNameCodec.mjs'"), 'mcpToolDefs 未接入 codec');
});

check('⑥d 连接入口（main/ipc/mcp.js）确实调用 codec 做可逆性前置校验', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/ipc/mcp.js'), 'utf8');
  assert.ok(src.includes("import('../../shared/mcpNameCodec.mjs')"), '入口未加载 codec');
  assert.ok(/decodeToolName\(codec\.buildToolName\(payload\.name/.test(src),
    '入口缺「拼名→反解」往返校验');
  // 既有长度校验必须保留（不因新增校验而删掉 old guard）
  assert.ok(/guard\.assertStrings\(payload,\s*\{\s*name:\s*120/.test(src), '入口 name ≤120 校验被删');
});

// ── ⑦ 入口校验语义（isEncodedNameSafe：可唯一反解才算安全） ──
check('⑦ isEncodedNameSafe：规范拼名 true；旧格式/非规范编码 false', () => {
  eq(isEncodedNameSafe(buildToolName('filesystem', 'read')), true);
  eq(isEncodedNameSafe(buildToolName('my__svc', 'x')), true);
  eq(isEncodedNameSafe(buildToolName('中文 服务', 'x')), true);
  eq(isEncodedNameSafe('mcp__filesystem__read'), true); // 安全名旧格式 == 规范格式
  eq(isEncodedNameSafe('mcp__my_svc__x'), false); // 旧格式未编码片段 → 非规范
  eq(isEncodedNameSafe('mcp__my%5f%5fsvc__x'), false); // 小写十六进制 → 非规范
  eq(isEncodedNameSafe('read_file'), false);
  eq(isEncodedNameSafe('mcp__x'), false);
});

check('⑦b 入口语义：任何非空常规服务名都能被「拼名→反解」唯一还原', () => {
  const names = ['filesystem', 'my__svc', '中文 服务', 'has space', '%weird%', 'a', '-', 'a-b_c'];
  for (const n of names) {
    const back = decodeToolName(buildToolName(n, 'probe'));
    eq(back, { server: n, tool: 'probe' }, `入口校验会误拒：${n}`);
  }
  // 空名无法拼出可反解的名字 → 入口应拒（服务名不可能为空）
  eq(decodeToolName(buildToolName('', 'probe')), null);
});

check('⑦c 入口语义有牙齿：非法 Unicode（孤立代理对）编码不可逆 → 必须被拒', () => {
  // UTF-8 编码会把孤立代理对折成 U+FFFD，反解结果与原名不同 —— 这类名字若被放进
  // mcp-servers.json，之后每次调用都会拿一个「名字变了」的 server 去查，永远查不到。
  const bad = 'a\uD800b';
  const back = decodeToolName(buildToolName(bad, 'probe'));
  assert.notDeepEqual(back && back.server, bad, '孤立代理对竟被判定为可逆');
  const accepted = back && back.server === bad && back.tool === 'probe';
  eq(accepted, false, '入口应拒绝该名字');
});

// ── ⑦d 编码后全名长度预算（B2-B-13） ──
// 缺陷形态：codec 对非安全字符按 UTF-8 逐字节 `%XX` 编码 → 中文 1 字符 = 9 字符。
//   入口此前只校验「原始 name ≤ 120 字符」，服务名段**无编码后上限**：30 个汉字的服务名
//   拼出的工具名 >270 字符，远超供应商 function.name 上限（本仓 mcpClient.js 对工具名段限 128）。
//   后果不是「连不上」，而是握手/列表都正常、每次把工具交给模型都被 400 拒 ——
//   表现成「连上了却调不动」，且报错与「服务名太长」无任何线索关联。
check('⑦d 长度预算与 mcpClient 的工具名上限同源（128，不是第二份独立数字）', () => {
  eq(MAX_ENCODED_FULL_NAME_CHARS, 128);
  // 从源码文本取，避免把 128 在测试里写死成「自己对自己的断言」
  const clientSrc = fs.readFileSync(path.join(ROOT, 'main/mcpClient.js'), 'utf8');
  const m = clientSrc.match(/const\s+TOOL_NAME_MAX\s*=\s*(\d+)\s*;/);
  assert.ok(m, 'mcpClient.js 未找到 TOOL_NAME_MAX 常量');
  eq(Number(m[1]), MAX_ENCODED_FULL_NAME_CHARS, 'codec 的预算与 mcpClient 的工具名上限分叉');
});

check('⑦d 超长中文服务名判不安全、短名判安全（边界逐字符对齐）', () => {
  // 30 个汉字 → 编码片段 270 字符，全名远超上限
  const longCn = '汉'.repeat(30);
  assert.ok(buildToolName(longCn, 't').length > MAX_ENCODED_FULL_NAME_CHARS,
    `构造失败：${buildToolName(longCn, 't').length}`);
  eq(isEncodedNameSafe(buildToolName(longCn, 't')), false, '超长中文服务名竟被判为安全');
  // 短名仍在预算内 → 必须放行（不许误伤现有中文配置）
  eq(isEncodedNameSafe(buildToolName('中文 服务', 't')), true, '短中文服务名被误拒');
  eq(isEncodedNameSafe(buildToolName('filesystem', 't')), true, '普通安全名被误拒');
  // 边界：'mcp__' + seg + '__' + 't' → 全名长度 = seg.length + 8
  const atCap = 'a'.repeat(MAX_ENCODED_FULL_NAME_CHARS - 8);
  const overCap = 'a'.repeat(MAX_ENCODED_FULL_NAME_CHARS - 7);
  eq(buildToolName(atCap, 't').length, MAX_ENCODED_FULL_NAME_CHARS, '边界构造失败');
  eq(isEncodedNameSafe(buildToolName(atCap, 't')), true, '恰好等于上限应放行');
  eq(isEncodedNameSafe(buildToolName(overCap, 't')), false, '超出一字符应拒绝');
});

check('⑦e 长度闸真的接在 mcp:connect 入口（不许只实现不接线）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/ipc/mcp.js'), 'utf8');
  assert.ok(src.includes('isEncodedNameSafe'), '入口未调用 isEncodedNameSafe');
  assert.ok(src.includes('MAX_ENCODED_FULL_NAME_CHARS'), '入口未引用长度预算常量');
  assert.ok(/编码后全名超限，请缩短服务名/.test(src), '拒绝文案未说明「编码后全名超限，请缩短服务名」');
  // 不许在 codec 内部截断（截断会破坏可逆性 —— F-005 的修复前提）
  const codecSrc = fs.readFileSync(path.join(ROOT, 'shared/mcpNameCodec.mjs'), 'utf8');
  assert.ok(!/encodeServerSegment[\s\S]{0,400}?\.slice\(0,\s*MAX_/.test(codecSrc), 'codec 内部出现了截断');
});

// ── ⑧ 调用点行为证据：意图预热的「已在本轮工具里就不重复连」必须按反解后的服务名判定 ──
// 这是 F-005 在 agentRunner 侧的功能证据（不止「不报错」）：
//   already 集合错 → targets 非空 → 每次命中意图都多一次 reconnectSaved（多握手/可能重复建会话）。
await acheck('⑧ agentRunner 意图预热：mcpTools 已含 my__svc 的工具 → 不重复发起连接', async () => {
  const { initAgentRunner, intentPrewarmToolDefs } = require(path.join(ROOT, 'main/agentRunner.js'));
  const calls = [];
  initAgentRunner({
    mcpDynamic: {
      reconnectSaved: async (n) => { calls.push(n); return { ok: true, tools: [{ name: 'notion_search', description: 'notion search' }] }; },
      loadConfig: () => [{ name: 'my__svc' }],
      // getManifest 返回清单对象（{tools:[...]}），不是裸数组 —— 见 agentRunner 的 manifests 装配
      getManifest: () => ({ tools: [{ name: 'notion_search', description: 'search notion pages' }] }),
    },
  });
  const payloadOf = (tools) => ({
    messages: [{ role: 'user', content: '帮我在 notion 里搜一下这周的会议记录' }],
    mcpTools: tools,
  });
  const live = [{ type: 'function', function: { name: buildToolName('my__svc', 'notion_search') } }];

  // 改前用 `__` 裸切得到的「服务名」——正是它让 already 永远漏判：
  const oldAlready = new Set(live.map((t) => String(t.function.name).split('__')[1]).filter(Boolean));
  assert.ok(!oldAlready.has('my__svc'),
    `旧实现竟能匹配到真实服务名（反例失效）：${[...oldAlready].join(',')}`);
  eq([...oldAlready], ['my%5F%5Fsvc'], '旧实现解出的应是编码串，而不是服务名');

  // 改后：反解命中 → 一次连接都不该发起
  const out = await intentPrewarmToolDefs(payloadOf(live));
  eq(calls, [], '已在本轮工具里的服务被重复连接了');
  eq(out, [], '不该并入任何新工具定义');

  // 反向控制：换成**别的**服务在场 → 应当照常补齐连接（证明不是「一律不连」的假绿）
  calls.length = 0;
  const other = [{ type: 'function', function: { name: buildToolName('other', 'notion_search') } }];
  const out2 = await intentPrewarmToolDefs(payloadOf(other));
  eq(calls, ['my__svc'], '真实落差未被补齐（过滤过度）');
  // 补齐的连接器工具定义，其名字必须能被反解回同一个服务（拼名/反解端到端闭合）
  eq(out2.length, 1, '补齐后应并入 1 个工具定义');
  eq(decodeToolName(out2[0].function.name), { server: 'my__svc', tool: 'notion_search' });
});

console.log(`\nmcp-name-codec: ${pass}/${total} 通过`);

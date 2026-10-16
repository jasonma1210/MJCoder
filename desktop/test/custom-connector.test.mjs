// 「自定义连接器」校验单测（lib/customConnector.ts 纯函数）
// 覆盖：名称必填/字符/查重；stdio 必填 command；http 必填且合法 url；env/headers 逐行解析与错误行号；
//      校验通过时产出的 payload 形状与主进程 mcp:connect 的入参一致。
// 运行：node test/custom-connector.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.join(import.meta.dirname, '..');
const MOD = pathToFileURL(path.join(ROOT, 'renderer', 'src', 'lib', 'customConnector.ts')).href;
const {
  emptyDraft, splitLines, parseKeyValueLines, isHttpUrl, validateCustomConnector,
} = await import(MOD);

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass += 1; }
  catch (e) { console.error(`❌ ${name} — ${e.message}`); fail += 1; }
}

const keys = (r) => r.issues.map((i) => i.key);
const stdioDraft = (over) => ({ ...emptyDraft(), name: 'my-server', transport: 'stdio', command: 'npx', ...over });
const httpDraft = (over) => ({ ...emptyDraft(), name: 'my-remote', transport: 'http', url: 'https://mcp.example.com/mcp', ...over });

// ── 行解析 ──
check('splitLines 去空行与首尾空白', () => {
  assert.deepEqual(splitLines('  a \n\n b\t\n'), ['a', 'b']);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines(null), []);
});
check('parseKeyValueLines 以第一个分隔符切分（值内含分隔符不误伤）', () => {
  const { map, badLines } = parseKeyValueLines('BASE_URL=https://a.com/x?y=1\nTOKEN=ab=cd', '=');
  assert.equal(map.BASE_URL, 'https://a.com/x?y=1');
  assert.equal(map.TOKEN, 'ab=cd');
  assert.deepEqual(badLines, []);
});
check('parseKeyValueLines 报出非法行号（1-based，便于用户定位）', () => {
  const { map, badLines } = parseKeyValueLines('OK=1\n没有等号\n2BAD=3\nGOOD=4', '=');
  assert.deepEqual(badLines, [2, 3]);
  assert.equal(map.OK, '1');
  assert.equal(map.GOOD, '4');
});
check('isHttpUrl 只接受 http/https 且必须有主机名', () => {
  assert.equal(isHttpUrl('https://mcp.example.com/mcp'), true);
  assert.equal(isHttpUrl('http://127.0.0.1:50501/api/v1/mcp'), true);
  assert.equal(isHttpUrl('ftp://x.com'), false);
  assert.equal(isHttpUrl('mcp.example.com'), false);
  assert.equal(isHttpUrl('http://'), false);
  assert.equal(isHttpUrl(''), false);
});

// ── stdio 校验 ──
check('stdio：合法草稿通过并产出正确 payload', () => {
  const r = validateCustomConnector(stdioDraft({
    args: '-y\n@modelcontextprotocol/server-filesystem\n/tmp',
    env: 'API_KEY=abc\nBASE_URL=https://x.com',
  }), []);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.deepEqual(r.payload, {
    name: 'my-server',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    env: { API_KEY: 'abc', BASE_URL: 'https://x.com' },
  });
});
check('stdio：缺 command 被拒', () => {
  assert.ok(keys(validateCustomConnector(stdioDraft({ command: '  ' }), [])).includes('ecosystem.custom.errCommandRequired'));
});
check('stdio：env 行格式错会被拒并给出行号', () => {
  const r = validateCustomConnector(stdioDraft({ env: 'OK=1\n坏行' }), []);
  assert.equal(r.ok, false);
  const issue = r.issues.find((i) => i.key === 'ecosystem.custom.errEnvLine');
  assert.ok(issue, keys(r).join(','));
  assert.equal(issue.params.lines, '2');
});
check('stdio：无参数无 env 也合法（本机工具常见，如仅需命令）', () => {
  const r = validateCustomConnector(stdioDraft({ args: '', env: '' }), []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.payload.args, []);
  assert.deepEqual(r.payload.env, {});
});

// ── http 校验 ──
check('http：合法草稿通过并产出 payload（不携带 stdio 字段）', () => {
  const r = validateCustomConnector(httpDraft({ headers: 'Authorization: Bearer abc' }), []);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.deepEqual(r.payload, {
    name: 'my-remote',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer abc' },
  });
  assert.equal('command' in r.payload, false);
});
check('http：缺 url 被拒', () => {
  assert.ok(keys(validateCustomConnector(httpDraft({ url: '' }), [])).includes('ecosystem.custom.errUrlRequired'));
});
check('http：非 http(s) 地址被拒（含裸域名/其他协议）', () => {
  for (const bad of ['mcp.example.com', 'ftp://x.com', 'file:///etc/passwd']) {
    assert.ok(keys(validateCustomConnector(httpDraft({ url: bad }), [])).includes('ecosystem.custom.errUrlScheme'), bad);
  }
});
check('http：headers 行格式错会被拒并给出行号', () => {
  const r = validateCustomConnector(httpDraft({ headers: 'Authorization: Bearer abc\n缺冒号' }), []);
  const issue = r.issues.find((i) => i.key === 'ecosystem.custom.errHeaderLine');
  assert.ok(issue);
  assert.equal(issue.params.lines, '2');
});

// ── 名称规则 ──
check('名称必填', () => {
  assert.ok(keys(validateCustomConnector(stdioDraft({ name: '   ' }), [])).includes('ecosystem.custom.errNameRequired'));
});
check('名称字符集受限（拒绝空格/中文/斜杠）', () => {
  for (const bad of ['my server', '我的服务', 'a/b', 'a:b']) {
    assert.ok(keys(validateCustomConnector(stdioDraft({ name: bad }), [])).includes('ecosystem.custom.errNameChars'), bad);
  }
  for (const good of ['my-server', 'my.server_1', 'A1']) {
    assert.equal(validateCustomConnector(stdioDraft({ name: good }), []).ok, true, good);
  }
});
check('名称查重：与既有服务同名必须被拒（否则会覆盖旧配置）', () => {
  const r = validateCustomConnector(stdioDraft({ name: 'filesystem' }), ['filesystem', 'other']);
  assert.equal(r.ok, false);
  const issue = r.issues.find((i) => i.key === 'ecosystem.custom.errNameTaken');
  assert.ok(issue);
  assert.equal(issue.params.name, 'filesystem');
});
check('名称查重：空名与既有名单中的空串不互相误伤', () => {
  const r = validateCustomConnector(stdioDraft({ name: 'fresh' }), ['', null, undefined]);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
});

// ── 结果对象自洽 ──
check('失败时 payload 必须为 null（调用方据此拒绝提交）', () => {
  const r = validateCustomConnector(stdioDraft({ command: '' }), []);
  assert.equal(r.ok, false);
  assert.equal(r.payload, null);
});
check('多条错误一次性返回（不做「修一个报一个」的挤牙膏）', () => {
  const r = validateCustomConnector({ ...emptyDraft(), name: 'bad name', transport: 'http', url: 'nope', headers: '坏' }, []);
  assert.ok(r.issues.length >= 3, `实际 ${r.issues.length} 条`);
});
check('错误项都是 i18n key（渲染层禁止裸中文，由 t() 求值）', () => {
  const r = validateCustomConnector({ ...emptyDraft(), transport: 'http' }, []);
  for (const i of r.issues) assert.ok(/^ecosystem\.custom\.err/.test(i.key), i.key);
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);

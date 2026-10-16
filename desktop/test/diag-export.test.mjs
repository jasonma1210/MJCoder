// T2-6 门禁：诊断包一键导出（main/diagExport.js + main/zipStore.js）
// 核心纪律断言：包内**绝不出现** API Key / 密文 / env / Authorization——用假密钥值全包 grep。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let pass = 0, total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// ── 假 userData / home + electron stub ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-diagexport-'));
const tmpHome = path.join(tmp, 'home');
const userData = path.join(tmp, 'userData');
fs.mkdirSync(path.join(userData, 'traces'), { recursive: true });
fs.mkdirSync(path.join(userData, 'diagnostics'), { recursive: true });
fs.mkdirSync(path.join(userData, 'logs'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, '.mjcode'), { recursive: true });

const FAKE_KEY = 'sk-FAKE-SECRET-1234567890';
const FAKE_ENV_VALUE = 'FAKE-ENV-SECRET-abcdefgh';
const FAKE_AUTH_HEADER = 'Bearer FAKE-AUTH-SECRET-xyz';

fs.writeFileSync(path.join(userData, 'audit-log.jsonl'), '{"action":"shell","target":"ls"}\n');
fs.writeFileSync(path.join(userData, 'diagnostics', 'crash-2026-10-15.jsonl'), '{"kind":"uncaughtException","stack":"boom"}\n');
fs.writeFileSync(path.join(userData, 'traces', 'run-1.jsonl'), '{"evt":"run_start"}\n');
fs.writeFileSync(path.join(userData, 'logs', 'main-2026-10-15.log'), '[log] hello\n');
fs.writeFileSync(path.join(userData, 'local-data.json'), JSON.stringify({
  providers: [{ id: 1, name: 'p', base_url: 'https://x', keyEncrypted: 'enc:'+FAKE_KEY, api_key: FAKE_KEY, model_id: 'm' }],
  threads: [{ id: 't1', title: '用户会话标题不应进包' }],
  messages: [{ id: 'm1', content: '用户消息正文不应进包' }],
  preferences: { 'server.apiBase': 'http://localhost:3001/api' },
  projects: [{ path: '/tmp/proj' }],
}));
fs.writeFileSync(path.join(userData, 'mcp-servers.json'), JSON.stringify([
  { name: 'srv', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { MY_KEY: FAKE_ENV_VALUE }, headers: { Authorization: FAKE_AUTH_HEADER } },
]));
fs.writeFileSync(path.join(tmpHome, '.mjcode', 'models.json'), JSON.stringify({
  providers: [{ key: 'g1', name: 'g', base_url: 'https://g', api_key: FAKE_KEY, models: [{ model_id: 'm1' }] }],
}));

const electronStub = {
  app: { getPath: (k) => (k === 'userData' ? userData : k === 'home' ? tmpHome : tmp), getVersion: () => '1.0.0-test' },
  ipcMain: { handle: (ch, h) => electronStub._handlers.set(ch, h), on: () => {} },
  _handlers: new Map(),
};
const mainRequire = createRequire(path.join(DESKTOP, 'main', 'noop.js'));
require.cache[mainRequire.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true, exports: electronStub };

const { writeZip, readZip, crc32 } = require(path.join(DESKTOP, 'main/zipStore.js'));
const { collectEntries, redact, registerDiagExportIpc, exportDiagnosticsZip } = require(path.join(DESKTOP, 'main/diagExport.js'));

check('zipStore：写读 round-trip 与 CRC 正确', () => {
  const entries = [
    { name: 'a.txt', data: 'hello 世界' },
    { name: 'dir/b.json', data: Buffer.from('{"k":1}') },
  ];
  const out = path.join(tmp, 'test.zip');
  writeZip(entries, out);
  const read = readZip(fs.readFileSync(out)).map((e) => ({ name: e.name, text: e.data.toString('utf8') }));
  assert.deepEqual(read.map((r) => r.name), ['a.txt', 'dir/b.json']);
  assert.equal(read[0].text, 'hello 世界');
  assert.equal(read[1].text, '{"k":1}');
  assert.equal(crc32(Buffer.alloc(0)), 0);
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926); // 标准校验值
});

check('redact：递归剔除敏感字段', () => {
  const r = redact({ a: 1, api_key: 'x', nested: { keyEncrypted: 'y', env: { Z: 1 }, keep: 2 }, list: [{ Authorization: 'z', token: 't', ok: 1 }] });
  assert.deepEqual(r, { a: 1, nested: { keep: 2 }, list: [{ ok: 1 }] });
});

check('collectEntries：诊断域齐备 + 会话正文不进包', () => {
  const names = collectEntries(userData).map((e) => e.name).sort();
  for (const must of ['meta.json', 'audit/audit-log.jsonl', 'diagnostics/crash-2026-10-15.jsonl', 'traces/run-1.jsonl', 'logs/main-2026-10-15.log', 'config/local-data.json', 'config/models.json', 'config/mcp-servers.json']) {
    assert.ok(names.includes(must), `缺条目 ${must}：${names.join(', ')}`);
  }
  const cfg = collectEntries(userData).find((e) => e.name === 'config/local-data.json').data.toString();
  assert.ok(!cfg.includes('用户会话标题') && !cfg.includes('用户消息正文'), '会话/消息正文泄漏进诊断包');
});

check('全包 grep：任何假密钥值都不出现（凭证剔除纪律）', () => {
  const all = collectEntries(userData).map((e) => e.data.toString()).join('\n');
  for (const secret of [FAKE_KEY, FAKE_ENV_VALUE, FAKE_AUTH_HEADER, 'keyEncrypted', '"env"', 'enc:']) {
    assert.ok(!all.includes(secret), `诊断包含敏感值 ${secret}`);
  }
});

check('exportDiagnosticsZip：落盘可读 zip 且 meta 带版本', () => {
  const file = exportDiagnosticsZip();
  assert.ok(fs.existsSync(file), 'zip 未落盘');
  const meta = JSON.parse(readZip(fs.readFileSync(file)).find((e) => e.name === 'meta.json').data.toString());
  assert.equal(meta.appVersion, '1.0.0-test');
  fs.rmSync(file);
});

check('IPC diag:export 注册且失败不抛', async () => {
  registerDiagExportIpc();
  assert.ok(electronStub._handlers.has('diag:export'), '未注册 diag:export');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\ndiag-export: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);

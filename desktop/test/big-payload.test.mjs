// T3-1 大消息 IPC 可靠传输测试。
// 覆盖：超限字段落盘卸载（字符串/对象）/ 小载荷透传 / IPC 消息体瘦身（10MB 场景）/
//      句柄分页拉取（offset·limit·hasMore·total）/ 非法 id 拒绝 / 过期句柄 /
//      run 结束即清（用后即清验收）/ runId 路径清洗防穿越 /
//      主渲染接线静态断言（agentRunner 卸载点 / previewScheme 协议 / CSP / FilePreview / ToolTrace）。
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

// ── 临时 userData + electron stub（protocol/net 供 previewScheme 顶层 require）──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-bigpayload-'));
const electronStub = {
  app: { getPath: () => tmp },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  net: { fetch: async () => new Response('') },
};
const mainRequire = createRequire(path.join(DESKTOP, 'main', 'noop.js'));
require.cache[mainRequire.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true, exports: electronStub };

const bp = require(path.join(DESKTOP, 'main/bigPayload.js'));
bp.initBigPayload({ dataDir: tmp });

const BIG = 'x'.repeat(bp.BIG_FIELD_BYTES + 1024); // 256KB+1

check('小载荷原样透传（不产生句柄与临时文件）', () => {
  const data = { name: 'shell', args: { command: 'ls' }, result: { stdout: 'a.txt\nb.txt', exitCode: 0 } };
  const out = bp.offloadToolCall('run-small', data);
  assert.equal(out, data, '小载荷应返回同一引用');
  assert.equal(fs.readdirSync(path.join(tmp, 'bigpayload')).length, 0, '不应落盘');
});

check('超限字符串字段卸载为 __bigStr 句柄（对象骨架保留）', () => {
  const out = bp.offloadToolCall('run-str', {
    name: 'shell', args: { command: 'make' },
    result: { stdout: BIG, exitCode: 2, error: null },
  });
  assert.equal(typeof out.result.stdout, 'object');
  assert.match(out.result.stdout.__bigStr, /^[0-9a-f]{16}$/, '句柄 id 形状不符');
  assert.equal(out.result.stdout.bytes, Buffer.byteLength(BIG));
  assert.equal(out.result.exitCode, 2, '小字段必须原样可见');
  assert.equal(out.result.error, null);
});

check('超限对象字段卸载为 __bigJson 句柄', () => {
  const bigArr = { rows: Array.from({ length: 20000 }, (_, i) => ({ i, text: 'row-line-padding-padding' })) };
  const out = bp.offloadToolCall('run-obj', { name: 'mcp__x__y', args: {}, result: { data: bigArr, ok: true } });
  assert.match(out.result.data.__bigJson, /^[0-9a-f]{16}$/);
  assert.equal(out.result.ok, true, '同层小字段保留');
});

check('10MB 构建日志场景：IPC 消息体 < 1KB（验收核心）', () => {
  const log = Array.from({ length: 300000 }, (_, i) => `[${i}] build step output line padding`).join('\n');
  assert.ok(Buffer.byteLength(log) > 10 * 1024 * 1024, '测试样本本身需 >10MB');
  const out = bp.offloadToolCall('run-10mb', { name: 'shell', args: { command: 'npm run build' }, result: { stdout: log, exitCode: 0 } });
  const wireBytes = Buffer.byteLength(JSON.stringify(out));
  assert.ok(wireBytes < 1024, `IPC 消息体应 <1KB，实际 ${wireBytes}B`);
});

check('句柄分页拉取：offset/limit/hasMore/total 语义正确', () => {
  const s = '0123456789'.repeat(bp.BIG_FIELD_BYTES); // 2.5MB+ 数字串
  const out = bp.offloadToolCall('run-page', { name: 'shell', args: {}, result: { stdout: s } });
  const id = out.result.stdout.__bigStr;
  const p0 = bp.fetchChunk({ id, offset: 0, limit: 100 });
  assert.equal(p0.ok, true);
  assert.equal(p0.text.length, 100);
  assert.equal(p0.total, s.length);
  assert.equal(p0.hasMore, true);
  const p1 = bp.fetchChunk({ id, offset: 100, limit: 100 });
  assert.equal(p1.text, s.slice(100, 200));
  const last = bp.fetchChunk({ id, offset: s.length - 5, limit: 100 });
  assert.equal(last.hasMore, false);
  assert.equal(last.text, s.slice(-5));
});

check('非法句柄 id 拒绝（fail-closed，不做文件读取）', () => {
  for (const bad of ['../../etc/passwd', 'short', 'Z'.repeat(16), '']) {
    const r = bp.fetchChunk({ id: bad });
    assert.equal(r.ok, false, `应拒绝：${bad}`);
  }
});

check('runId 清洗进文件名：路径穿越字符不可入文件名', () => {
  const out = bp.offloadToolCall('../../evil', { name: 'shell', args: {}, result: { stdout: BIG } });
  const id = out.result.stdout.__bigStr;
  const files = fs.readdirSync(path.join(tmp, 'bigpayload')).filter((f) => f.includes(id));
  assert.equal(files.length, 1);
  assert.ok(!files[0].includes('..'), `文件名残留穿越序列：${files[0]}`);
  assert.ok(!files[0].includes('/'));
});

check('releaseRun 用后即清：句柄表与临时文件同步删除', () => {
  const out = bp.offloadToolCall('run-clean', { name: 'shell', args: {}, result: { stdout: BIG } });
  const id = out.result.stdout.__bigStr;
  assert.ok(bp._handles().has(id));
  bp.releaseRun('run-clean');
  assert.ok(!bp._handles().has(id), '句柄应已移除');
  const left = fs.readdirSync(path.join(tmp, 'bigpayload')).filter((f) => f.includes(id));
  assert.equal(left.length, 0, '临时文件应已删除');
  assert.equal(bp.fetchChunk({ id }).ok, false, '释放后不可再拉取');
});

check('过期句柄拉取被拒并即时清理（TTL 语义）', () => {
  const out = bp.offloadToolCall('run-expire', { name: 'shell', args: {}, result: { stdout: BIG } });
  const id = out.result.stdout.__bigStr;
  bp._handles().get(id).expires = Date.now() - 1; // 模拟 TTL 到期
  const r = bp.fetchChunk({ id });
  assert.equal(r.ok, false);
  assert.equal(r.expired, true, '应带 expired 标记供 UI 显示「内容已过期」');
  assert.ok(!bp._handles().has(id));
  bp.releaseRun('run-expire');
});

// ── previewScheme：token 授予与形状 ──
const ps = require(path.join(DESKTOP, 'main/previewScheme.js'));

check('grantPreviewToken 返回一次性随机 mjpreview:// URL（URL 不含路径）', () => {
  const u1 = ps.grantPreviewToken('/tmp/whatever.png');
  const u2 = ps.grantPreviewToken('/tmp/whatever.png');
  assert.match(u1, /^mjpreview:\/\/p\/[0-9a-f]{32}$/);
  assert.ok(u1 !== u2, 'token 应一次性随机，不可预测');
  assert.ok(!u1.includes('whatever'), 'URL 不得携带文件路径');
});

// ── 接线静态断言（主进程卸载点 / 协议注册时序 / 渲染层消费）──
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8');

check('agentRunner：tool_call 发送前卸载 + run 结束释放句柄', () => {
  const src = read('main/agentRunner.js');
  assert.match(src, /type === 'tool_call' \? bigPayload\.offloadToolCall\(runId, data\)/);
  assert.match(src, /bigPayload\.releaseRun\(runId\)/);
});

check('main.js：scheme 特权注册早于 ready，协议处理器在 whenReady 内', () => {
  const src = read('main/main.js');
  const privAt = src.indexOf('registerPreviewSchemePrivileges()');
  const readyAt = src.indexOf('app.whenReady()');
  assert.ok(privAt > 0 && privAt < readyAt, 'registerSchemesAsPrivileged 必须先于 whenReady');
  assert.match(src, /previewScheme\.initPreviewScheme\(\)/);
  assert.match(src, /bigPayload\.initBigPayload\(\{ dataDir: app\.getPath\('userData'\) \}\)/);
  assert.match(src, /bigPayload\.registerBigPayloadIpc\(ipcMain\)/);
});

check('previewTool.js：file:preview 超 256KB 二进制改发 previewUrl（不再 base64 过 IPC）', () => {
  // 2026-10-16 file:preview 单元自 exec.js 拆出至 previewTool.js（800 行 God File 门禁）
  const src = read('main/tools/previewTool.js');
  assert.match(src, /PREVIEW_INLINE_MAX = 256 \* 1024/);
  assert.match(src, /st\.size > PREVIEW_INLINE_MAX[\s\S]{0,400}previewUrl: grantPreviewToken\(target\)/);
  // dataUrl 路径仍在（小文件保留内联）
  assert.match(src, /dataUrl: `data:\$\{mime\};base64/);
});

check('CSP 放行 mjpreview:（img/media/frame），preload 暴露分页通道', () => {
  const html = read('renderer/index.html');
  assert.match(html, /img-src 'self' data: blob: mjpreview:/);
  assert.match(html, /media-src 'self' data: blob: mjpreview:/);
  assert.match(html, /frame-src 'self' data: blob: mjpreview:/);
  const preload = read('main/preload.js');
  assert.match(preload, /bigPayloadFetch: \(payload\) => ipcRenderer\.invoke\('bigPayload:fetch', payload\)/);
});

check('渲染层消费链：ToolTrace 句柄分流+虚拟滚动，FilePreview 支持 previewUrl', () => {
  const tt = read('renderer/src/components/tools/ToolTrace.tsx');
  assert.match(tt, /isBigRef\(text\)/);
  assert.match(tt, /BigOutputBlock/);
  assert.match(tt, /VirtualText/);
  const vt = read('renderer/src/components/VirtualText.tsx');
  assert.match(vt, /VIRTUAL_MIN_LINES/);
  assert.match(vt, /scrollTop|scrollTop/);
  const fp = read('renderer/src/components/FilePreview.jsx');
  assert.ok((fp.match(/meta\.previewUrl \|\| meta\.dataUrl/g) || []).length >= 4, '四类媒体标签都应优先 previewUrl');
});

console.log(`\n[big-payload] ${pass}/${total} 通过`);
bp._shutdown();
fs.rmSync(tmp, { recursive: true, force: true });

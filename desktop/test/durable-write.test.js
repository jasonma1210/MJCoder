// durableWrite.js 测试：原子写原语 + fsync + 权限 + mode 语义
//
// 覆盖（对应设计文档 §13.7 之外的 L1 原语用例 D1–D4）：
//   D1 原子性：写过程不留半写文件，目标文件内容完整
//   D2 权限：writeFileDurableWithMode 后目标文件模式正确（加密令牌/密钥保护）
//   D3 mode 对已存在文件无效（Node 语义）：显式记录，避免误用
//   D4 失败路径：目标目录不可写时返回 {ok:false} 且不抛错、清理残留 tmp
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileDurable, writeFileDurableWithMode, appendDurable, openAppend, closeFd, fsyncDir } = require('../main/data/durableWrite');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-durable-'));

// ── D1 原子写 ──
{
  const file = path.join(tmp, 'atomic.json');
  const payload = JSON.stringify({ a: 1, b: 'x'.repeat(5000) });
  const r = writeFileDurable(file, payload);
  check('D1 写入返回 ok', r.ok === true && typeof r.dirFsynced === 'boolean');
  check('D1 目标文件内容完整', fs.readFileSync(file, 'utf8') === payload);
  check('D1 无残留 tmp', fs.readdirSync(tmp).filter((f) => f.includes('.tmp')).length === 0);

  // 覆盖写：内容被完整替换，非追加
  writeFileDurable(file, 'short');
  check('D1 覆盖写非追加', fs.readFileSync(file, 'utf8') === 'short');

  // Buffer 输入
  const bin = path.join(tmp, 'bin.dat');
  const buf = Buffer.from([0, 1, 2, 255, 254]);
  check('D1 Buffer 输入', writeFileDurable(bin, buf).ok && Buffer.compare(fs.readFileSync(bin), buf) === 0);
}

// ── D2 权限 ──
if (process.platform !== 'win32') {
  const file = path.join(tmp, 'secret.json');
  const r = writeFileDurableWithMode(file, '{"access":"enc"}', 0o600);
  check('D2 mode 应用成功', r.ok === true && r.modeApplied === true);
  const mode = (fs.statSync(file).mode & 0o777);
  check('D2 目标文件为 0600', mode === 0o600, `实际 ${mode.toString(8)}`);

  // 已存在文件再次写：权限仍被强制（这正是不能用 openSync mode 的原因）
  const r2 = writeFileDurableWithMode(file, '{"access":"enc2"}', 0o600);
  const mode2 = (fs.statSync(file).mode & 0o777);
  check('D2 已存在文件重复写后仍为 0600', r2.modeApplied === true && mode2 === 0o600, `实际 ${mode2.toString(8)}`);
} else {
  console.log('⏭️  D2 Windows 上 chmod 语义受限，跳过权限断言（modeApplied 如实上报）');
}

// ── D3 mode 对已存在文件无效（Node 语义，显式记录防止误用）──
{
  const file = path.join(tmp, 'mode-semantics.json');
  // 先以默认权限创建
  writeFileDurable(file, 'v1');
  const before = (fs.statSync(file).mode & 0o777);
  // writeFileDurable 无 mode 参数，重复写不改变权限
  writeFileDurable(file, 'v2');
  const after = (fs.statSync(file).mode & 0o777);
  check('D3 writeFileDurable 不更改既有文件权限', before === after, `${before.toString(8)} → ${after.toString(8)}`);
  // 需要显式权限时必须走 writeFileDurableWithMode
  if (process.platform !== 'win32') {
    const f2 = path.join(tmp, 'mode-required.json');
    writeFileDurable(f2, 'v1');
    const m1 = fs.statSync(f2).mode & 0o777;
    writeFileDurableWithMode(f2, 'v2', 0o600);
    const m2 = fs.statSync(f2).mode & 0o777;
    check('D3 需权限时必须用 WithMode 变体', m2 === 0o600 && m2 !== m1, `${m1.toString(8)} → ${m2.toString(8)}`);
  }
}

// ── D4 失败路径 ──
{
  // 父路径是文件 → mkdirSync 抛错 → 应返回 {ok:false} 而非崩溃
  const blocker = path.join(tmp, 'blocker');
  fs.writeFileSync(blocker, 'not a dir');
  const r = writeFileDurable(path.join(blocker, 'child.json'), 'x');
  check('D4 目标不可写返回 ok:false 且不抛错', r.ok === false && typeof r.error === 'string');
  check('D4 失败不产生残留 tmp（在 blocker 同级）', !fs.existsSync(blocker + '.tmp'));

  // appendDurable 对坏 fd 也应返回 ok:false 而非抛错
  const bad = appendDurable(-1, 'line\n');
  check('D4 appendDurable 坏 fd 返回 ok:false', bad.ok === false);
}

// ── 追加写往返 ──
{
  const file = path.join(tmp, 'append.jsonl');
  const fd = openAppend(file);
  check('openAppend 返回 fd', typeof fd === 'number' && fd >= 0);
  const r1 = appendDurable(fd, '{"seq":1}');
  const r2 = appendDurable(fd, '{"seq":2}'); // 自带 \n
  check('appendDurable 两条均 ok', r1.ok && r2.ok);
  closeFd(fd);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  check('appendDurable 每行一条且补 \n', lines.length === 2 && lines[0] === '{"seq":1}' && lines[1] === '{"seq":2}');

  // closeFd 幂等
  closeFd(fd);
  closeFd(null);
  closeFd(undefined);
  check('closeFd 幂等（不抛错）', true);
}

// ── fsyncDir ──
{
  check('fsyncDir 对目录不抛错', typeof fsyncDir(tmp) === 'boolean');
  check('fsyncDir 对坏路径返回 false', fsyncDir(path.join(tmp, 'no-such-dir')) === false);
}

console.log(`\ndurableWrite 原语：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);

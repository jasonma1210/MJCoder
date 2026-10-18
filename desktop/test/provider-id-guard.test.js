// providerId 形状门禁（2026-10-18）
//
// 这个坑已经踩过三次，每次都是「校验写得更严了，结果把真实调用挡在门外」：
//   ① 2026-10-17 `local:messages/add`：threadId 是数字，被 assertTokens（字符串语义）拦下，
//      用户所有消息写不进去、run 直接中止。
//   ② 2026-10-18 定时任务「改模型」：providerId 是本机自增**数字**，被 assertStrings 拦下，
//      报「载荷非法：providerId 必须是字符串（收到 number）」。
//   ③ 同型：`assertIds` 只收数字，会把厂商名/全局 id（'deepseek' / 's…'）拦下 —— 也不能用于 providerId。
//
// 事实（main.js 的 resolveSecret 注释里早就写着）：providerId **两种形态都合法**
//   本机 provider = 自增数字 id；全局/服务端 = 字符串（'s…' 前缀 / 厂商名）。
//   resolveSecret 用 `Number(providerId)` 与 `String(providerId)` 双向兜底，正是为了兼容两种。
//
// 故规矩只有一条：providerId 只能用 assertIdLike（数字或非空字符串），
// 不许出现在 assertStrings / assertIds 的字段清单里。
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'main');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(full);
  }
  return out;
}
// 注释里的示例不算数：抹成空格、保留行号
function blankComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

const files = walk(MAIN);

check('main/ 下没有任何地方把 providerId 当长度受限的字符串校验', () => {
  const hits = [];
  for (const f of files) {
    const src = blankComments(fs.readFileSync(f, 'utf8'));
    src.split('\n').forEach((line, i) => {
      // 错误写法长这样：`providerId: { max: 120, optional: true }`
      if (/providerId\s*:\s*\{[^}]*max\s*:/.test(line)) hits.push(`${path.relative(ROOT, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], `providerId 不能用 assertStrings 校验：${hits.join(', ')}`);
});

check('scheduler 的任务模型改用 assertIdLike（含 setModel 通道）', () => {
  const src = blankComments(fs.readFileSync(path.join(MAIN, 'scheduler.js'), 'utf8'));
  const hits = src.match(/assertIdLike\([^)]*providerId[^)]*\)/g) || [];
  assert.ok(hits.length >= 2, `应有两处（scheduled:save / scheduled:setModel），实际 ${hits.length} 处`);
});

check('assertIdLike 本身接受数字与字符串、拒绝对象/数组/空串（行为自证）', () => {
  const guard = require('../main/ipc/payloadGuard');
  assert.equal(typeof guard.assertIdLike, 'function', 'payloadGuard 未导出 assertIdLike');
  // 正样本：两种真实形态
  guard.assertIdLike({ providerId: 3 }, ['providerId']);
  guard.assertIdLike({ providerId: '3' }, ['providerId']);
  guard.assertIdLike({ providerId: 'deepseek' }, ['providerId']);
  guard.assertIdLike({ providerId: 's123' }, ['providerId']);
  // 未提供 = 合法（由上层决定是否回落）
  guard.assertIdLike({}, ['providerId']);
  guard.assertIdLike({ providerId: null }, ['providerId']);
  // 负样本：这些都是「脏数据形状」，必须拒
  for (const bad of [{}, [], '', true, NaN]) {
    assert.throws(() => guard.assertIdLike({ providerId: bad }, ['providerId']), /providerId/,
      `应拒绝 ${JSON.stringify(bad)}`);
  }
});

console.log(`\nprovider-id-guard: ${pass}/${total} 通过`);
if (pass !== total) process.exitCode = 1;

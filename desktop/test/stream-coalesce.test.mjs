// X11 回归门禁：流式合帧器的行为约束。
//
// 为什么单独测它：这个模块决定「流式文本什么时候提交到界面」，一旦退化成
// ①每个 token 都提交（性能回退）或 ②把过期值写回（幽灵消息），
// 都只有长会话实际跑起来才看得出来。这里用纯逻辑断言把三条不变量钉住。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(DESKTOP, 'renderer/src');
const esbuild = require(path.join(DESKTOP, 'renderer/node_modules/esbuild'));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}
async function checkAsync(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// 用 esbuild 把 .ts 直接编成 CJS（渲染层新文件必须是 TS，Node 不能直接 import）
const tsPath = path.join(SRC, 'lib/streamCoalescer.ts');
const code = esbuild.transformSync(fs.readFileSync(tsPath, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
const mod = { exports: {} };
new Function('exports', 'module', 'require', code)(mod.exports, mod, require);
const { makeCoalescer } = mod.exports;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

check('导出可用的工厂函数', () => {
  if (typeof makeCoalescer !== 'function') throw new Error('makeCoalescer 未导出');
});

await checkAsync('同一帧内的多次 push 合并为一次提交，取最后一次的值', async () => {
  const seen = [];
  const push = makeCoalescer((v) => seen.push(v));
  push('a'); push('ab'); push('abc');
  if (seen.length !== 0) throw new Error(`不该同步提交，实际 ${seen.length} 次`);
  await sleep(180);
  if (seen.length !== 1) throw new Error(`应只提交 1 次，实际 ${seen.length} 次`);
  if (seen[0] !== 'abc') throw new Error(`应提交最后一次的值 abc，实际 ${seen[0]}`);
});

await checkAsync('shouldCommit 为假时丢弃待提交值（防幽灵消息）', async () => {
  const seen = [];
  let alive = true;
  const push = makeCoalescer((v) => seen.push(v), () => alive);
  push('运行中的文本');
  alive = false; // 模拟本轮已结束、界面已清空
  await sleep(180);
  if (seen.length !== 0) throw new Error(`运行结束后仍提交了 ${seen.length} 次（会出现幽灵文本）`);
});

await checkAsync('flushNow 幂等：重复调用不会重复提交', async () => {
  const seen = [];
  const push = makeCoalescer((v) => seen.push(v));
  push('x');
  push.flushNow();
  push.flushNow();
  await sleep(180);
  if (JSON.stringify(seen) !== '["x"]') throw new Error(`期望 ["x"]，实际 ${JSON.stringify(seen)}`);
});

await checkAsync('cancel 丢弃待提交值', async () => {
  const seen = [];
  const push = makeCoalescer((v) => seen.push(v));
  push('half');
  push.cancel();
  await sleep(180);
  if (seen.length !== 0) throw new Error(`cancel 后仍提交了 ${seen.length} 次`);
});

await checkAsync('跨帧的两批增量各提交一次（不丢中间结果）', async () => {
  const seen = [];
  const push = makeCoalescer((v) => seen.push(v));
  push('first');
  await sleep(180);
  push('first-second');
  await sleep(180);
  if (seen.length !== 2) throw new Error(`应提交 2 次，实际 ${seen.length} 次`);
  if (seen[1] !== 'first-second') throw new Error(`最后一次应为 first-second，实际 ${seen[1]}`);
});

console.log(`\nstream-coalesce: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);

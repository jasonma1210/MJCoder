// X14 回归门禁：写通道载荷校验器的行为约束。
//
// 为什么单独测：这些断言挂在「写用户数据/凭证/调度」的通道上，一旦被改松
// （比如为了兼容某个调用方而放宽 assertIds），脏数据会静默落库，
// 事后只能靠用户报「多了一条空白服务 / 任务跑不起来」才发现。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const guard = require(path.join(DESKTOP, 'main/ipc/payloadGuard.js'));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}
/** 断言某段调用必须抛出 PayloadError */
function mustThrow(fn, label) {
  try { fn(); } catch (e) {
    if (e.code !== 'INVALID_PAYLOAD') throw new Error(`${label} 抛的不是 PayloadError：${e.message}`);
    return e.message;
  }
  throw new Error(`${label} 应当被拒绝，但通过了`);
}

// ── assertObject ──
check('对象通过', () => guard.assertObject({ a: 1 }));
check('数组被拒（载荷应为对象）', () => mustThrow(() => guard.assertObject([1, 2]), '数组'));
check('null / 字符串被拒', () => { mustThrow(() => guard.assertObject(null), 'null'); mustThrow(() => guard.assertObject('x'), '字符串'); });

// ── assertStrings ──
check('必填字符串正常通过', () => guard.assertStrings({ name: 'openai' }, { name: 120 }));
check('缺失必填被拒', () => mustThrow(() => guard.assertStrings({}, { name: 120 }), '缺 name'));
check('空串被拒（默认非空）', () => mustThrow(() => guard.assertStrings({ name: '   ' }, { name: 120 }), '空白 name'));
check('非字符串被拒（数字 id 落在字符串字段上）', () => mustThrow(() => guard.assertStrings({ name: 123 }, { name: 120 }), '数字 name'));
check('超长被拒', () => mustThrow(() => guard.assertStrings({ name: 'x'.repeat(121) }, { name: 120 }), '超长'));
check('optional 允许缺省', () => guard.assertStrings({}, { api_key: { max: 10, optional: true } }));
check('allowEmpty 允许空串（暂不填 Key）', () => guard.assertStrings({ api_key: '' }, { api_key: { max: 10, allowEmpty: true } }));

// ── assertIds ──
check('数字 id 通过', () => guard.assertIds({ id: 7 }, ['id']));
check('数字字符串 id 通过', () => guard.assertIds({ id: '7' }, ['id']));
check('对象 id 被拒（会写成 [object Object]）', () => mustThrow(() => guard.assertIds({ id: {} }, ['id']), '对象 id'));
check('缺失 id 被拒', () => mustThrow(() => guard.assertIds({}, ['id']), '缺 id'));
check('NaN 被拒', () => mustThrow(() => guard.assertIds({ id: NaN }, ['id']), 'NaN id'));

// ── assertTokens ──
check('标识符通过', () => guard.assertTokens({ threadId: 't-123' }, { threadId: 128 }));
check('含空白被拒', () => mustThrow(() => guard.assertTokens({ threadId: 'a b' }, { threadId: 128 }), '含空格'));
check('超长标识符被拒', () => mustThrow(() => guard.assertTokens({ threadId: 'a'.repeat(129) }, { threadId: 128 }), '超长'));
check('optional 标识符允许缺省', () => guard.assertTokens({}, { projectPath: { max: 256, optional: true } }));

// ── assertArray ──
check('数组通过', () => guard.assertArray({ messages: [1] }, 'messages', { max: 10, min: 1 }));
check('非数组被拒', () => mustThrow(() => guard.assertArray({ messages: 'x' }, 'messages', { max: 10 }), '非数组'));
check('超过上限被拒（防一次 IPC 撑爆内存）', () => mustThrow(() => guard.assertArray({ messages: new Array(11).fill(0) }, 'messages', { max: 10 }), '超上限'));

// ── 错误可读性：必须指出字段名，否则排障等于猜 ──
check('错误信息包含字段名', () => {
  const msg = mustThrow(() => guard.assertStrings({}, { base_url: 2000 }), '缺 base_url');
  if (!msg.includes('base_url')) throw new Error(`错误信息未包含字段名：${msg}`);
});

console.log(`\nipc-payload-guard: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);

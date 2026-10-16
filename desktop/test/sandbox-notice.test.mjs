// A3 回归门禁：沙箱/执行失败的结构化说明（desktop/shared/sandboxNotice.mjs）
//
// 为什么必须有这个测试：该映射决定用户看到的是「原因 / 受影响动作 / 当前档位 / 安全下一步」
// 还是底层原文（operation not permitted）。若映射出现空洞（新增错误码未配文案、或 i18n key
// 未落地），UI 会把 i18n key 原样显示给用户——这是「静默退化」，必须有行为断言拦住。
//
// 断言分三层：
//   ① 行为：真实构造各错误码结果对象，断言解释字段（不读源码字符串）；
//   ② 完整性：错误码清单与文案映射一一对应，不遗漏；
//   ③ 跨文件一致性：所有 key 在 zh-CN 与 en-US 的 runtime.json 中**都存在**
//      （数据驱动比对，替代此前「断言源码里出现过某字符串」的反模式）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SANDBOX_ERROR_CODES, sandboxNoticeOf } from '../shared/sandboxNotice.mjs';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass += 1; }
  catch (e) { console.error(`❌ ${name} — ${e.message}`); fail += 1; }
}

const LOCALES = ['zh-CN', 'en-US'];

// ── ① 行为断言：每个错误码都产出完整四要素 ──
for (const code of SANDBOX_ERROR_CODES) {
  check(`错误码 ${code} 产出完整解释（原因/动作/档位/下一步）`, () => {
    const n = sandboxNoticeOf({ errorCode: code, stderr: '底层原因示例', exitCode: -1, blocked: true });
    assert.ok(n, '应返回说明对象');
    assert.equal(n.code, code);
    for (const k of ['titleKey', 'reasonKey', 'actionKey', 'nextStepKey']) {
      assert.ok(n[k] && n[k].startsWith('runtime.'), `${k} 必须是 runtime.* 的 i18n key，实际=${n[k]}`);
    }
  });
}

// ── ② 语义正确性：阻断类 vs 「结果不可知」必须区分 ──
check('未执行类错误码 blocked=true，动作文案是「未执行」', () => {
  const n = sandboxNoticeOf({ errorCode: 'sandbox-unavailable', blocked: true });
  assert.equal(n.blocked, true);
  assert.equal(n.actionKey, 'runtime.sandboxActionNotExecuted');
});

check('result-unknown 用「可能已执行」文案，且不得声称未执行', () => {
  const n = sandboxNoticeOf({ errorCode: 'result-unknown', sandbox: { sandboxed: true, backend: 'windows-restricted-user' } });
  assert.equal(n.actionKey, 'runtime.sandboxActionExecutedUnknown');
  assert.notEqual(n.actionKey, 'runtime.sandboxActionNotExecuted');
});

check('Windows 后端走 Windows 专用下一步指引', () => {
  const n = sandboxNoticeOf({ errorCode: 'sandbox-unavailable', sandbox: { policy: 'workspace-write', backend: 'windows-restricted-user' } });
  assert.equal(n.nextStepKey, 'runtime.sandboxNextStepWindows');
});

check('非 Windows 后端走通用下一步指引', () => {
  const n = sandboxNoticeOf({ errorCode: 'sandbox-unavailable', sandbox: { policy: 'read-only', backend: 'seatbelt' } });
  assert.equal(n.nextStepKey, 'runtime.sandboxNextStepGeneric');
});

check('档位与隔离状态如实透出（供 UI 显示当前水位）', () => {
  const n = sandboxNoticeOf({ errorCode: 'command-guard-blocked', sandbox: { policy: 'workspace-write', sandboxed: false } });
  assert.equal(n.policy, 'workspace-write');
  assert.equal(n.sandboxed, false);
});

check('非沙箱类失败返回 null（不把普通错误误报成安全事件）', () => {
  assert.equal(sandboxNoticeOf({ exitCode: 1, stderr: 'TS2304: Cannot find name' }), null);
  assert.equal(sandboxNoticeOf(null), null);
  assert.equal(sandboxNoticeOf('字符串结果'), null);
});

// ── ③ 跨文件一致性：文案 key 在两种语言里都必须存在（否则 UI 显示裸 key）──
const HERE = import.meta.dirname;

const locales = Object.fromEntries(LOCALES.map((l) => [
  l,
  JSON.parse(fs.readFileSync(path.join(HERE, '..', 'renderer', 'src', 'i18n', 'locales', l, 'runtime.json'), 'utf8')),
]));

// 收集本模块可能返回的全部 key（含共享常量，避免漏测）
const ALL_KEYS = new Set();
for (const code of SANDBOX_ERROR_CODES) {
  for (const variant of [{}, { sandbox: { backend: 'windows-restricted-user' } }, { sandbox: { backend: 'bubblewrap' } }]) {
    const n = sandboxNoticeOf({ errorCode: code, ...variant });
    ALL_KEYS.add(n.titleKey); ALL_KEYS.add(n.reasonKey); ALL_KEYS.add(n.actionKey); ALL_KEYS.add(n.nextStepKey);
  }
}
ALL_KEYS.add('runtime.sandboxPolicyLine');
ALL_KEYS.add('runtime.sandboxIsolatedYes');
ALL_KEYS.add('runtime.sandboxIsolatedNo');

for (const locale of LOCALES) {
  check(`${locale}：结构化沙箱说明的全部文案 key 均存在`, () => {
    const missing = [...ALL_KEYS].filter((k) => {
      const short = k.replace(/^runtime\./, '');
      return typeof locales[locale][short] !== 'string' || !locales[locale][short].length;
    });
    assert.deepEqual(missing, [], `缺失 key: ${missing.join(', ')}`);
  });
}

check('两种语言的 runtime.json key 集合一致（防单边新增）', () => {
  const a = Object.keys(locales['zh-CN']).sort();
  const b = Object.keys(locales['en-US']).sort();
  assert.deepEqual(a.filter((k) => !b.includes(k)), [], 'zh-CN 有而 en-US 缺');
  assert.deepEqual(b.filter((k) => !a.includes(k)), [], 'en-US 有而 zh-CN 缺');
});

// ── ④ 安全口径：下一步指引不得建议关闭隔离 ──
check('下一步指引不出现「改用 full-access」式建议（关闭全部隔离）', () => {
  for (const locale of LOCALES) {
    const text = locales[locale].sandboxNextStepGeneric + locales[locale].sandboxNextStepWindows;
    assert.ok(/不建议改为 full-access|full-access is not recommended/.test(text),
      `${locale} 缺「不建议 full-access」的明确表述`);
  }
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);

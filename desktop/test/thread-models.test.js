// 模型与会话绑定（renderer/src/lib/threadModels.ts）的行为测试
//
// 为什么需要这层：用户要的是「会话 A 用 DeepSeek、会话 B 用别的，切回去还是原来的」。
// 这个需求最容易坏在三个地方，都必须在测试里钉住：
//   ① 两个会话互相覆盖（全局单键的老毛病）；
//   ② providerId 类型不匹配（本机 provider 是自增**数字**，全局是 's…' 串）→ 恢复失败；
//   ③ 记录里的供应商/模型被删掉后抛异常，让界面卡在「没有模型」。
//
// TS 源码在 node 里不能直接 require：用项目自带的 esbuild 打成 cjs 再加载。
// localStorage 用内存桩（Map），不依赖浏览器。
const assert = require('node:assert/strict');
const path = require('path');
// esbuild 装在 renderer/node_modules（渲染层自己的依赖），desktop 根目录没有
const esbuild = require(require.resolve('esbuild', { paths: [path.join(__dirname, '..', 'renderer')] }));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// ── localStorage 桩 ──
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};

// ── 打包被测模块 ──
const src = path.join(__dirname, '..', 'renderer', 'src', 'lib', 'threadModels.ts');
const built = esbuild.buildSync({
  entryPoints: [src], bundle: true, format: 'cjs', platform: 'node', write: false,
});
const mod = { exports: {} };
new Function('module', 'exports', 'require', built.outputFiles[0].text)(mod, mod.exports, require);
const { readThreadModel, writeThreadModel, forgetThreadModel, resolveModel, planThreadSwitch, isBindable } = mod.exports;

// 两个供应商：一个本机（数字 id），一个全局（字符串 id）
const PROVIDERS = [
  { id: 1, models: [{ model_id: 'deepseek-chat', display_name: 'DeepSeek Chat' }] },
  { id: 's7', isGlobal: true, models: [{ model_id: 'gpt-x', display_name: 'GPT X' }] },
];
const selA = { provider: { id: 1 }, model: { model_id: 'deepseek-chat' } };
const selB = { provider: { id: 's7' }, model: { model_id: 'gpt-x' } };

function reset() { store.clear(); }

check('往返：写入后能按会话读回', () => {
  reset();
  writeThreadModel('t1', selA);
  assert.deepEqual(readThreadModel('t1'), { providerId: 1, modelId: 'deepseek-chat' });
});

check('隔离：会话 A 与 B 各记各的，互不覆盖（全局单键的老毛病）', () => {
  reset();
  writeThreadModel('tA', selA);
  writeThreadModel('tB', selB);
  assert.deepEqual(readThreadModel('tA'), { providerId: 1, modelId: 'deepseek-chat' });
  assert.deepEqual(readThreadModel('tB'), { providerId: 's7', modelId: 'gpt-x' });
});

check('覆写：同一会话换模型只影响自己', () => {
  reset();
  writeThreadModel('tA', selA);
  writeThreadModel('tB', selB);
  writeThreadModel('tA', selB);
  assert.deepEqual(readThreadModel('tA'), { providerId: 's7', modelId: 'gpt-x' });
  assert.deepEqual(readThreadModel('tB'), { providerId: 's7', modelId: 'gpt-x' });
});

check('解析：数字 providerId（本机自增 id）能匹配', () => {
  const m = resolveModel(PROVIDERS, { providerId: 1, modelId: 'deepseek-chat' });
  assert.ok(m, '数字 id 应能解析');
  assert.equal(m.provider.id, 1);
  assert.equal(m.model.model_id, 'deepseek-chat');
});

check('解析：字符串 providerId 能匹配，且数字/字符串混用不算匹配失败', () => {
  const m = resolveModel(PROVIDERS, { providerId: 's7', modelId: 'gpt-x' });
  assert.ok(m);
  assert.equal(m.provider.id, 's7');
  // 记录里存成字符串 "1"、供应商是数字 1 —— 也必须认得（localStorage 往返可能变字符串）
  const m2 = resolveModel(PROVIDERS, { providerId: '1', modelId: 'deepseek-chat' });
  assert.ok(m2, '字符串 "1" 应匹配数字 1');
});

check('解析失败：供应商被删 / 模型下线 → 返回 null（调用方回落当前模型，不抛）', () => {
  assert.equal(resolveModel(PROVIDERS, { providerId: 999, modelId: 'deepseek-chat' }), null);
  assert.equal(resolveModel(PROVIDERS, { providerId: 1, modelId: 'removed-model' }), null);
  assert.equal(resolveModel([], { providerId: 1, modelId: 'deepseek-chat' }), null);
  assert.equal(resolveModel(PROVIDERS, null), null);
});

check('无记录 / 坏 JSON：安静回落 null，不抛', () => {
  reset();
  assert.equal(readThreadModel('never-seen'), null);
  store.set('mj_thread_models', '{ 这不是 json');
  assert.equal(readThreadModel('t1'), null);
  store.set('mj_thread_models', '"just-a-string"');
  assert.equal(readThreadModel('t1'), null);
});

check('残缺记录：缺 providerId 或 modelId 都当作没有', () => {
  reset();
  store.set('mj_thread_models', JSON.stringify({ t1: { providerId: 1 }, t2: { modelId: 'x' } }));
  assert.equal(readThreadModel('t1'), null);
  assert.equal(readThreadModel('t2'), null);
});

check('forget：删除会话后记录消失', () => {
  reset();
  writeThreadModel('t1', selA);
  forgetThreadModel('t1');
  assert.equal(readThreadModel('t1'), null);
});

check('空 threadId / 空模型：写入被忽略，不产生垃圾键', () => {
  reset();
  writeThreadModel('', selA);
  writeThreadModel(null, selA);
  writeThreadModel('t1', null);
  writeThreadModel('t1', { provider: { id: 1 } });
  assert.equal(store.get('mj_thread_models') || '{}', '{}');
});

check('上限：超过 500 条时丢最旧的键，不会无限膨胀', () => {
  reset();
  for (let i = 0; i < 505; i++) writeThreadModel(`t${i}`, selA);
  const map = JSON.parse(store.get('mj_thread_models'));
  assert.equal(Object.keys(map).length, 500);
  assert.equal(map.t0, undefined, '最旧的应被淘汰');
  assert.ok(map.t504, '最新的应保留');
});

check('storage 写不进去（隐私模式）时不抛，读回落 null', () => {
  reset();
  const orig = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  try {
    writeThreadModel('t1', selA); // 不抛即通过
    assert.equal(readThreadModel('t1'), null);
  } finally {
    globalThis.localStorage.setItem = orig;
  }
});

// ── 切换决策：这是「切会话换模型」唯一的分水岭 ──
// 写错的两种表现都很难从界面上看出来：①切了会话模型没变 ②把别的会话的记录冲掉。
check('决策：没有会话 → none（欢迎页不该动任何绑定）', () => {
  assert.deepEqual(planThreadSwitch({ threadId: null, saved: null, resolved: null, current: selA }), { type: 'none' });
});

check('决策：该会话没有记录 + 当前模型可用 → seed（新会话延续当前模型）', () => {
  assert.deepEqual(
    planThreadSwitch({ threadId: 't1', saved: null, resolved: null, current: selA }),
    { type: 'seed' },
  );
});

check('决策：当前模型不可用（没有 provider/model）→ none，不写垃圾记录', () => {
  assert.deepEqual(planThreadSwitch({ threadId: 't1', saved: null, resolved: null, current: null }), { type: 'none' });
  assert.deepEqual(planThreadSwitch({ threadId: 't1', saved: null, resolved: null, current: { provider: {} } }), { type: 'none' });
});

check('决策：有记录且能解析 → restore', () => {
  const saved = { providerId: 1, modelId: 'deepseek-chat' };
  assert.deepEqual(
    planThreadSwitch({ threadId: 't1', saved, resolved: { provider: PROVIDERS[0], model: {} }, current: selB }),
    { type: 'restore' },
  );
});

check('决策：有记录但解析不到（供应商未加载/已删）→ pending，等 providers 到了再试', () => {
  const saved = { providerId: 1, modelId: 'deepseek-chat' };
  assert.deepEqual(
    planThreadSwitch({ threadId: 't1', saved, resolved: null, current: selA }),
    { type: 'pending' },
  );
});

check('isBindable：数字/字符串 providerId 都可绑定，缺 model_id 不可', () => {
  assert.equal(isBindable(selA), true);
  assert.equal(isBindable(selB), true);
  assert.equal(isBindable({ provider: { id: '' }, model: { model_id: 'x' } }), false);
  assert.equal(isBindable({ provider: { id: 1 }, model: {} }), false);
  assert.equal(isBindable(null), false);
});

console.log(`\nthread-models: ${pass}/${total} 通过`);
if (pass !== total) process.exitCode = 1;

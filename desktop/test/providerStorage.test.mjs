// 回归防护：模型凭证必须落本机数据库（localStore + safeStorage），不得写入服务端
// 对应缺陷：首启向导「配置模型」因服务端不可达报「保存失败：Failed to fetch」
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const API_PATH = pathToFileURL(path.join(ROOT, 'renderer/src/lib/api.js')).href;

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// ── 环境桩：模拟渲染层 window.mjcode / localStorage / fetch ──
const calls = [];
function stub({ online = false } = {}) {
  calls.length = 0;
  const localProviders = new Map();
  global.window = {
    mjcode: {
      localAddProvider: async (p) => {
        calls.push({ channel: 'local:providers/add', payload: p });
        const id = localProviders.size + 1;
        const row = { id, name: p.name, base_url: p.base_url, modelId: p.model_id || '' };
        localProviders.set(id, row);
        return row;
      },
      localSetProviderModel: async (p) => {
        calls.push({ channel: 'local:providers/set-model', payload: p });
        return { id: p.id, modelId: p.model_id };
      },
      localDeleteProvider: async (p) => {
        calls.push({ channel: 'local:providers/delete', payload: p });
        return { ok: true };
      },
      localProviders: async () => [...localProviders.values()],
    },
  };
  global.localStorage = { getItem: () => 'stub-token', removeItem() {}, setItem() {} };
  global.fetch = online
    ? async (url) => ({ ok: true, status: 200, json: async () => (String(url).includes('/providers') ? [{ id: 7, name: '服务端模型', base_url: 'https://x/v1', models: [] }] : {}) })
    : async () => { throw new TypeError('Failed to fetch'); };
}

// ── 用例 ──
await (async () => {
  stub({ online: false });
  const { api, humanizeError, setLocalMode } = await import(API_PATH);
  setLocalMode(false); // 关键：即使"在线"态（持有令牌），凭证也必须落本机

  const created = await api.addProvider({ name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-x', model_id: 'deepseek-chat' });

  check('保存模型走本机 IPC，不发起任何 HTTP', () => {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].channel, 'local:providers/add');
  });
  check('本机写入含 model_id，落库即可用', () => {
    assert.equal(calls[0].payload.model_id, 'deepseek-chat');
    assert.equal(created.modelId, 'deepseek-chat');
  });

  const list = await api.providers();
  check('服务端不可达时模型列表降级为本机条目（不抛错）', () => {
    assert.equal(list.length, 1);
    assert.equal(list[0].source, 'local');
    assert.equal(list[0].models[0].model_id, 'deepseek-chat');
  });

  await api.addModel(created.id, { model_id: 'deepseek-reasoner' });
  check('切换模型走本机 IPC', () => {
    assert.ok(calls.some((c) => c.channel === 'local:providers/set-model'));
  });

  await api.deleteProvider(created.id);
  check('删除本机模型走本机 IPC', () => {
    assert.ok(calls.some((c) => c.channel === 'local:providers/delete'));
  });

  check('原始英文错误转中文可读文案', () => {
    const msg = humanizeError(new TypeError('Failed to fetch'));
    assert.ok(!/failed to fetch/i.test(msg), msg);
    assert.ok(msg.includes('本机'), msg);
  });

  // 在线态：服务端条目带 s 前缀做命名空间隔离，本机条目保持数字 id
  stub({ online: true });
  await api.addProvider({ name: '本机模型', base_url: 'https://local/v1', api_key: 'sk-l', model_id: 'local-1' });
  const mixed = await api.providers();
  const local = mixed.find((p) => p.source === 'local');
  const server = mixed.find((p) => p.source === 'server');
  check('在线态本机条目在前且 id 为数字', () => {
    assert.equal(mixed[0].source, 'local');
    assert.equal(typeof local.id, 'number');
  });
  check('服务端条目 id 加 s 前缀，避免与本机 id 冲突', () => {
    assert.equal(server.id, 's7');
  });

  // 主进程 resolveSecret 的命名空间约定（s 前缀剥离后命中 u: 轨道）
  const strip = (id) => String(id).replace(/^s/, '');
  check('服务端 id 剥离 s 前缀后还原为服务端主键', () => {
    assert.equal(strip('s7'), '7');
    assert.equal(strip(7), '7');
  });

  console.log(`\nPASS：${pass}/${total} 项通过`);
})();

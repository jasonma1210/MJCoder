// 自定义模型配置文件（modelsFile.js）测试：解析校验 / WorkBuddy 格式兼容 / 同步对账幂等 / 剪除
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LocalStore } = require('../main/localStore');
const {
  fileKeyFor, toBaseUrl, parseModelsFile, templateContent, ensureModelsFile, syncFileModels,
} = require('../main/modelsFile');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 最小加密桩：与 LocalStore 解耦（sync 只要求 encrypt(plain)->cipher 可逆性由真实 CredentialCrypto 保证）
const encrypt = (k) => `enc(${k})`;

function makeStore() {
  return new LocalStore(fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-mf-')));
}

(async () => {
  // ── 1. 解析：合法条目 + url 归一 + 能力字段 ──
  const raw1 = JSON.stringify([
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4 Flash', vendor: 'DeepSeek', url: 'https://api.deepseek.com/chat/completions', apiKey: 'sk-test-1', supportsToolCall: true, supportsImages: false, supportsReasoning: true },
  ]);
  const r1 = parseModelsFile(raw1);
  check('解析：1 个 provider / 0 错误', r1.providers.length === 1 && r1.errors.length === 0);
  check('解析：完整端点剥成 base_url', r1.providers[0].base_url === 'https://api.deepseek.com');
  check('解析：模型 id/显示名/能力归一',
    r1.providers[0].models[0].modelId === 'deepseek-v4-flash'
    && r1.providers[0].models[0].displayName === 'DeepSeek-V4 Flash'
    && r1.providers[0].models[0].caps.supportsToolCall === true
    && r1.providers[0].models[0].caps.supportsReasoning === true);
  check('解析：provider 名取 vendor', r1.providers[0].name === 'DeepSeek');

  // ── 2. 同 url+Key 归并多模型；不同 Key 分provider ──
  const raw2 = JSON.stringify([
    { id: 'm1', url: 'http://127.0.0.1:1234/v1', apiKey: 'demo' },
    { id: 'm2', name: '模型二', url: 'http://127.0.0.1:1234/v1', apiKey: 'demo' },
    { id: 'm3', url: 'http://127.0.0.1:1234/v1', apiKey: 'other' },
  ]);
  const r2 = parseModelsFile(raw2);
  check('归并：同 url+Key 合为一个 provider（2 模型），不同 Key 分开（共 2 provider）',
    r2.providers.length === 2
    && r2.providers[0].models.length === 2
    && r2.providers[1].models.length === 1,
    JSON.stringify(r2.providers.map((p) => p.models.length)));

  // ── 3. apiKeyEnv 间接引用 + 环境变量缺失告警 ──
  const raw3 = JSON.stringify([{ id: 'env-model', url: 'https://api.x.com/v1', apiKeyEnv: 'MY_TEST_KEY_X' }]);
  const r3a = parseModelsFile(raw3, { env: { MY_TEST_KEY_X: 'sk-from-env' } });
  check('apiKeyEnv：从环境变量取 Key', r3a.providers[0].apiKey === 'sk-from-env' && r3a.errors.length === 0);
  const r3b = parseModelsFile(raw3, { env: {} });
  check('apiKeyEnv：变量缺失仍导入但告警', r3b.providers.length === 1 && r3b.providers[0].apiKey === '' && r3b.errors.length === 1);

  // ── 4. 非法输入：坏 JSON / 非数组 / 缺 id / 缺 url ──
  check('校验：坏 JSON 报错', parseModelsFile('{oops').errors.length === 1);
  check('校验：非数组报错', parseModelsFile('{"a":1}').errors.length === 1);
  const r4 = parseModelsFile(JSON.stringify([{ url: 'https://x.com' }, { id: 'ok', url: 'not-a-url' }, { id: 'good', url: 'https://y.com/v1' }]));
  check('校验：坏条目逐条报错，好条目照常导入', r4.errors.length === 2 && r4.providers.length === 1 && r4.providers[0].models[0].modelId === 'good');

  // ── 5. 同步对账：新增 → 更新 → 剪除 → 幂等 ──
  const store = makeStore();
  const vault = new Map();
  const sync = (raw) => syncFileModels({ store, encrypt, vault, raw, filePath: '/tmp/never-written.json' });

  const first = sync(JSON.stringify([
    { id: 'm1', url: 'https://a.com/v1', apiKey: 'k1' },
    { id: 'm2', url: 'https://a.com/v1', apiKey: 'k1' },
  ]));
  check('同步：首次导入 1 provider（2 模型）', first.synced === 1 && first.removed.length === 0 && store.listProviders().length === 1);
  const p1 = store.listProviders()[0];
  check('同步：provider 带 source=file 标记与 models 列表', p1.source === 'file' && p1.models.length === 2);
  check('同步：Key 注入 vault（明文不出现在 store）', vault.get(p1.id)?.api_key === 'k1' && p1.keyEncrypted === undefined);
  check('同步：store 内加密形态正确', store.getProviderKey(p1.id) === 'enc(k1)');

  // 文件改动：m1/m2 改名 + 新增 m3 → 同一 fileKey 复用同一 provider，不产生重复
  const second = sync(JSON.stringify([
    { id: 'm1', name: '改名一', url: 'https://a.com/v1', apiKey: 'k1' },
    { id: 'm2', url: 'https://a.com/v1', apiKey: 'k1' },
    { id: 'm3', url: 'https://a.com/v1', apiKey: 'k1' },
  ]));
  check('同步：文件改动后仍是 1 个 provider（复用身份）', store.listProviders().length === 1 && second.synced === 1);
  const p1b = store.listProviders()[0];
  check('同步：模型列表整体更新（3 个，含改名）', p1b.models.length === 3 && p1b.models.some((m) => m.displayName === '改名一'));

  // 条目从文件消失 → provider 剪除；vault 同步清理由调用方（main）负责，此处验证 store 侧
  const third = sync(JSON.stringify([{ id: 'm9', url: 'https://b.com/v1', apiKey: 'k2' }]));
  check('同步：消失条目被剪除（旧 1 删、新 1 入）', third.removed.length === 1 && store.listProviders().length === 1 && store.listProviders()[0].base_url === 'https://b.com/v1');

  // 幂等：同内容重复 sync 不再增删
  const fourth = sync(JSON.stringify([{ id: 'm9', url: 'https://b.com/v1', apiKey: 'k2' }]));
  check('同步：重复 sync 幂等（无新增无剪除）', fourth.synced === 1 && fourth.removed.length === 0 && store.listProviders().length === 1);

  // 手工添加的 provider 不受剪除影响
  store.addProvider({ name: '手工', base_url: 'https://c.com', keyEncrypted: 'enc(x)', modelId: 'mm' });
  sync(JSON.stringify([{ id: 'm9', url: 'https://b.com/v1', apiKey: 'k2' }]));
  check('同步：UI 手工添加的 provider 不被文件同步误删', store.listProviders().length === 2);

  // ── 6. 模板与 ensureModelsFile ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-mf-tpl-'));
  const tplPath = path.join(dir, 'models.json');
  const created = ensureModelsFile(tplPath);
  check('模板：文件创建成功且 JSON 可解析为数组', created.created === true && Array.isArray(JSON.parse(fs.readFileSync(tplPath, 'utf8'))));
  const again = ensureModelsFile(tplPath);
  check('模板：已存在时不覆盖', again.created === false);
  check('模板：内容不含真实 Key（占位符）', templateContent().includes('请替换成你的Key'));
  const mode = fs.statSync(tplPath).mode & 0o777;
  check('模板：文件权限 0600（含 Key 的文件不组/众可读）', mode === 0o600, `mode=${mode.toString(8)}`);

  // ── 7. fileKey 稳定性 ──
  check('fileKey：同输入同输出、异输入异输出',
    fileKeyFor('https://a.com', 'k1') === fileKeyFor('https://a.com', 'k1')
    && fileKeyFor('https://a.com', 'k1') !== fileKeyFor('https://a.com', 'k2'));

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });

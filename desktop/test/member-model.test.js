// M5 / T5-7 军团成员模型绑定测试：
//   引用串编解码（单源）/ 非法与超长回落 null / resolveModelRef 解析本机供应商
//   / teamStore 落库 canonical 化与解绑 / agentRunner 覆盖会话模型与失效回落
//   / shared-ipc 契约对 rolePreset.model 的边界校验
//
// 设计依据（唯一事实来源）：main/modelShape.js 的 MODEL_REF_* 约定
//   · 引用串形态 `providerId::modelId`（分隔符沿用 main/scheduledGuard.js 的 `::` 先例）
//   · fail-closed：任何解析不出的输入 → null（= 用会话默认模型），绝不因绑定失效失败整轮
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  MODEL_REF_MAX, encodeModelRef, decodeModelRef, canonicalizeModelRef, resolveModelRef, toAgentModel,
} = require('../main/modelShape');
const { openDbAsync } = require('../main/db');
const { TeamStore } = require('../main/teamStore');
const { initAgentRunner, startAgentRun, agentRunnerReady } = require('../main/agentRunner');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 本机供应商样例（形状对齐 localStore.listProviders 的真实输出）──
const PROVIDERS = [
  {
    id: 1, name: '本机 DeepSeek', base_url: 'https://api.deepseek.com/v1', isGlobal: false,
    models: [
      { modelId: 'deepseek-chat', displayName: 'DeepSeek Chat', caps: { tools: true } },
      { modelId: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner' },
    ],
  },
  // 服务端来源的供应商：id 为 's…' 字符串（两形状 id 混用是既有事实，必须都能解析）
  { id: 's12', name: '云端网关', base_url: 'https://gw.example.com/v1', isGlobal: true, models: [{ modelId: 'gw-large' }] },
];

(async () => {
  // ══ A. 引用串编解码（单一事实来源）══
  check('encode 正常往返', encodeModelRef({ providerId: '1', modelId: 'deepseek-chat' }) === '1::deepseek-chat');
  check('encode 两侧去空白', encodeModelRef({ providerId: ' 1 ', modelId: ' deepseek-chat ' }) === '1::deepseek-chat');
  check('encode 缺 providerId → null', encodeModelRef({ modelId: 'm' }) === null);
  check('encode 缺 modelId → null', encodeModelRef({ providerId: '1' }) === null);
  check('encode 非对象 → null', encodeModelRef('1::m') === null && encodeModelRef(null) === null);
  check('encode 任一侧含分隔符 → null（切分点必须唯一）',
    encodeModelRef({ providerId: 'a::b', modelId: 'm' }) === null
    && encodeModelRef({ providerId: '1', modelId: 'a::b' }) === null);
  check('encode 超长 providerId → null', encodeModelRef({ providerId: 'p'.repeat(31), modelId: 'm' }) === null);
  check('encode 超长 modelId → null', encodeModelRef({ providerId: '1', modelId: 'm'.repeat(129) }) === null);
  check(`边界：providerId 30 + modelId 128 恰好 ${MODEL_REF_MAX} 放行（两侧上限即总长上限）`,
    encodeModelRef({ providerId: 'p'.repeat(30), modelId: 'm'.repeat(128) })?.length === MODEL_REF_MAX);

  check('decode 正常还原', JSON.stringify(decodeModelRef('1::deepseek-chat')) === JSON.stringify({ providerId: '1', modelId: 'deepseek-chat' }));
  check('decode 前后空白容忍', JSON.stringify(decodeModelRef('  1::m  ')) === JSON.stringify({ providerId: '1', modelId: 'm' }));
  check('decode 非字符串 → null', decodeModelRef(1) === null && decodeModelRef(null) === null && decodeModelRef(undefined) === null);
  check('decode 无分隔符 → null', decodeModelRef('deepseek-chat') === null);
  check('decode 分隔符在首/尾 → null', decodeModelRef('::m') === null && decodeModelRef('1::') === null);
  check('decode 多分隔符 → null（绝不猜测切分点）', decodeModelRef('a::b::c') === null);
  check(`decode 超长串 → null`, decodeModelRef('x'.repeat(MODEL_REF_MAX + 1)) === null);
  check('decode 缺一侧 → null', decodeModelRef('  ::  ') === null);
  check('decode 绝不对合法串抛错', typeof decodeModelRef('1::m') === 'object');

  // 往返不变量：合法串 decode → encode 回到原串（引用串格式只有一个判据）
  const rt = 's12::gw-large';
  check('往返不变量 encode(decode(s)) === s', encodeModelRef(decodeModelRef(rt)) === rt);

  // ══ B. canonicalize（落库前唯一的清洗判据）══
  check('canonicalize null/空串 → null', canonicalizeModelRef(null) === null && canonicalizeModelRef('') === null);
  check('canonicalize 纯空白串 → null', canonicalizeModelRef('   ') === null);
  check('canonicalize 对象入参 → 引用串', canonicalizeModelRef({ providerId: '1', modelId: 'm' }) === '1::m');
  check('canonicalize 引用串入参 → 原串', canonicalizeModelRef('1::m') === '1::m');
  check('canonicalize 脏串入参 → null（fail-closed）',
    canonicalizeModelRef('不是引用串') === null && canonicalizeModelRef('a::b::c') === null
    && canonicalizeModelRef({ providerId: 'a::b', modelId: 'm' }) === null);

  // ══ C. resolveModelRef（解析到本机供应商，解析不到回落 null）══
  const r1 = resolveModelRef('1::deepseek-chat', PROVIDERS);
  check('解析成功：扁平形输出 + 供应商地址',
    r1 && r1.providerId === '1' && r1.baseUrl === 'https://api.deepseek.com/v1' && r1.model === 'deepseek-chat',
    JSON.stringify(r1));
  check('caps 声明时随解析带上（能力位不丢）', !!r1 && r1.caps && r1.caps.tools === true);
  const r2 = resolveModelRef('1::deepseek-reasoner', PROVIDERS);
  check('未声明 caps 时不造空对象（避免被读成「已声明但无字段」）', !!r2 && !Object.prototype.hasOwnProperty.call(r2, 'caps'));
  const r3 = resolveModelRef('s12::gw-large', PROVIDERS);
  check('字符串 id 供应商可解析（服务端来源兼容）', !!r3 && r3.providerId === 's12' && r3.isGlobal === true && r3.model === 'gw-large');
  check('供应商已删除 → null（回落默认模型）', resolveModelRef('9::deepseek-chat', PROVIDERS) === null);
  check('模型已删除 → null', resolveModelRef('1::gone-model', PROVIDERS) === null);
  check('坏记录/空值 → null', resolveModelRef('坏串', PROVIDERS) === null && resolveModelRef(null, PROVIDERS) === null);
  check('providers 缺失也不抛', resolveModelRef('1::deepseek-chat', undefined) === null);

  // 解析结果继续走既有形状转换（解析 + 转换两段各自单一职责）
  const nested = toAgentModel(r1);
  check('解析结果可转嵌套形（引擎契约）',
    nested.provider.id === '1' && nested.model.model_id === 'deepseek-chat' && nested.model.context_window > 0);

  // ══ D. 落库 canonical 化与解绑（teamStore.normalizeMemberInput 单点）══
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-member-model-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const store = new TeamStore(db);
  const team = store.createTeam({ name: '模型绑定组', description: '验证 per-agent 模型', projectPath: '/proj/m' });

  const byObj = store.addMember(team.id, { name: '对象入参', model: { providerId: '1', modelId: 'deepseek-chat' } });
  check('对象入参落库为 canonical 引用串', byObj.model === '1::deepseek-chat');
  const byStr = store.addMember(team.id, { name: '串入参', model: 's12::gw-large' });
  check('引用串入参原样落库', byStr.model === 's12::gw-large');
  const byBad = store.addMember(team.id, { name: '坏入参', model: '不是引用串' });
  check('非法入参落 null（fail-closed，= 用默认模型）', byBad.model === null);
  const noModel = store.addMember(team.id, { name: '未声明' });
  check('未声明模型时落 null', noModel.model === null);

  // 改绑 / 解绑走同一条清洗链
  const rebound = store.updateMember(team.id, byStr.id, { model: { providerId: '1', modelId: 'deepseek-reasoner' } });
  check('改绑：对象入参 → canonical 串', rebound.model === '1::deepseek-reasoner');
  const unbound = store.updateMember(team.id, byStr.id, { model: null });
  check('解绑：显式 null → 落 null', unbound.model === null);
  // patch 语义：未给出 model 键时不得改动既有绑定（否则「改审批档」会顺手清掉模型）
  const rebound2 = store.updateMember(team.id, byStr.id, { model: '1::deepseek-chat' });
  const untouched = store.updateMember(team.id, byStr.id, { approvalMode: 'auto-safe' });
  check('patch 未含 model 时不改动既有绑定', rebound2.model === '1::deepseek-chat' && untouched.model === '1::deepseek-chat');

  // 重启恢复：canonical 串是持久化形态，必须原样读回
  db.flush();
  const db2 = await openDbAsync(dir, { driver: 'sqljs' });
  const store2 = new TeamStore(db2);
  const reloaded = store2.getMember(team.id, byObj.id);
  check('重启后绑定串原样保持', !!reloaded && reloaded.model === '1::deepseek-chat');

  // ══ E. agentRunner 消费（覆盖会话模型 / 失效回落）══
  await agentRunnerReady();
  const captured = [];
  const newSender = () => {
    const s = { events: [], destroyed: false, send: null, isDestroyed: () => s.destroyed };
    s.send = (ch, data) => { if (ch === 'agent:event') s.events.push(data); };
    return s;
  };

  const vp = (runId, extra = {}) => ({
    messages: [{ role: 'user', content: 'hi' }],
    model: { provider: { id: 1, isGlobal: false, base_url: 'https://session.example/v1' }, model: { model_id: 'session-model', context_window: 128000 } },
    cwd: '/tmp/p',
    ...extra,
    runId,
  });

  // 用例 1：绑定有效 → 覆盖会话模型
  captured.length = 0;
  initAgentRunner({
    loadAgentCore: async () => ({ runAgent: async (opts) => { captured.push(opts); opts.onDone?.('完成', { prompt_tokens: 1, completion_tokens: 1 }, false); return '完成'; } }),
    createToolHandlers: () => ({}),
    resolveModelRef: (ref) => resolveModelRef(ref, PROVIDERS),
  });
  const s1 = newSender();
  const rres = startAgentRun(vp('m1', { rolePreset: { model: '1::deepseek-chat' } }), s1);
  check('startAgentRun 接受带 rolePreset.model 的载荷', rres.ok === true);
  await sleep(60);
  check('绑定有效：引擎拿到的是绑定模型（不是会话模型）',
    !!captured[0] && captured[0].model?.provider?.id === '1' && captured[0].model?.model?.model_id === 'deepseek-chat',
    JSON.stringify(captured[0]?.model?.model?.model_id));
  check('绑定生效时本轮正常收尾（done 事件）', s1.events.some((e) => e.type === 'done'));

  // 用例 2：绑定失效（供应商已删）→ 回落会话模型，且整轮不失败
  captured.length = 0;
  initAgentRunner({
    loadAgentCore: async () => ({ runAgent: async (opts) => { captured.push(opts); opts.onDone?.('完成', { prompt_tokens: 1, completion_tokens: 1 }, false); return '完成'; } }),
    createToolHandlers: () => ({}),
    resolveModelRef: (ref) => resolveModelRef(ref, PROVIDERS),
  });
  const s2 = newSender();
  startAgentRun(vp('m2', { rolePreset: { model: '9::gone' } }), s2);
  await sleep(60);
  check('失效绑定：回落会话默认模型',
    !!captured[0] && captured[0].model?.model?.model_id === 'session-model',
    JSON.stringify(captured[0]?.model?.model?.model_id));
  check('失效绑定不失败整轮（仍发 done，无 error 事件）',
    s2.events.some((e) => e.type === 'done') && !s2.events.some((e) => e.type === 'error'));

  // 用例 3：无绑定 → 与会话模型一致（既往行为不变）
  captured.length = 0;
  initAgentRunner({
    loadAgentCore: async () => ({ runAgent: async (opts) => { captured.push(opts); opts.onDone?.('完成', { prompt_tokens: 1, completion_tokens: 1 }, false); return '完成'; } }),
    createToolHandlers: () => ({}),
    resolveModelRef: (ref) => resolveModelRef(ref, PROVIDERS),
  });
  const s3 = newSender();
  startAgentRun(vp('m3', { rolePreset: { toolNames: ['read_file'] } }), s3);
  await sleep(60);
  check('未声明 model：沿用会话模型（既有行为不变）',
    !!captured[0] && captured[0].model?.model?.model_id === 'session-model');

  // 用例 4：deps 未注入 resolveModelRef（旧宿主）→ 不崩，回落会话模型
  captured.length = 0;
  initAgentRunner({
    loadAgentCore: async () => ({ runAgent: async (opts) => { captured.push(opts); opts.onDone?.('完成', { prompt_tokens: 1, completion_tokens: 1 }, false); return '完成'; } }),
    createToolHandlers: () => ({}),
  });
  const s4 = newSender();
  startAgentRun(vp('m4', { rolePreset: { model: '1::deepseek-chat' } }), s4);
  await sleep(60);
  check('缺少 resolveModelRef 依赖时不崩，回落会话模型',
    !!captured[0] && captured[0].model?.model?.model_id === 'session-model' && s4.events.some((e) => e.type === 'done'));

  // ══ F. 契约边界（shared-ipc/contract.mjs）══
  const contract = await import('../shared-ipc/contract.mjs');
  const good = {
    runId: 'c1',
    messages: [{ role: 'user', content: 'hi' }],
    model: { provider: { id: 1 }, model: { model_id: 'm' } },
    cwd: '/tmp/p', conversationId: 'c1', approvalMode: 'on-request', sandboxPolicy: 'workspace-write',
    planMode: false, tokenBudget: 600000, resumeContext: '', mcpTools: [], enabledSkills: [], skills: [], memories: [],
  };
  check('契约放行 rolePreset.model（合法引用串）',
    contract.validateAgentRunPayload({ ...good, rolePreset: { model: '1::deepseek-chat' } }).ok);
  check('契约放行 rolePreset.model = null（解绑）',
    contract.validateAgentRunPayload({ ...good, rolePreset: { model: null } }).ok);
  check('契约放行 rolePreset.model 缺省',
    contract.validateAgentRunPayload({ ...good, rolePreset: { toolNames: ['read_file'] } }).ok);
  check(`契约拒绝超长引用串（> ${MODEL_REF_MAX}）`,
    !contract.validateAgentRunPayload({ ...good, rolePreset: { model: 'x'.repeat(MODEL_REF_MAX + 1) } }).ok);
  check('契约拒绝非字符串 model（形状漂移即拦截）',
    !contract.validateAgentRunPayload({ ...good, rolePreset: { model: 123 } }).ok);
  check('契约拒绝非对象 rolePreset',
    !contract.validateAgentRunPayload({ ...good, rolePreset: 'bad' }).ok);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

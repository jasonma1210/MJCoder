// Worker 成员身份段（R-16 / 第九轮 X-2）守护套件
//
// 背景（产品边界专题）：
//   Worker 首条 system 此前是同一句通用串，军团成员人格靠 rolePreset 事后补——
//   「未配人格的成员」与「纯自动编排的公共 Worker」在 system 首条完全同形。
//   workerIdentity.js 补的正是这一句身份；本套件锁三件事：
//     ① 行为：非军团路径（未认领/无名册成员/反查异常）**字节不变**——零回归判据；
//     ② 行为：有名成员才追加身份段，且成员名截断；
//     ③ 接线：workerPool 真的调用了拆分出的两个函数，且 applyMemberRuntimeConfig
//        （per-bot 配置）没有被这次拆分改坏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const {
  resolveOwnerMember, memberIdentitySuffix, buildWorkerSystemPrompt, MEMBER_NAME_MAX,
} = require(path.join(ROOT, 'main/workerIdentity.js'));

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`✅ ${name}`); }
  catch (e) { fail++; console.error(`❌ ${name} — ${e.message}`); process.exitCode = 1; }
};

// ── ① 零回归判据：迁移前的两条原文（逐字锁死，防「顺手优化」改掉 self 指令） ──
const LEGACY_CHAT = '你是 MJ Coder 的团队成员。本轮只需在对话中直接说一句话：按用户消息里的格式原样输出一行文本；不得调用任何工具、不得读写文件、不得执行命令、不得解释或寒暄。';
const LEGACY_TASK = '你是 MJ Coder 的并行任务 Worker：只完成分配给你的子任务，产出精炼、可执行的结论。'
  + '完成前必须自测验证：能运行测试/命令验证的就实际运行，写完的文件就回读确认关键内容存在；验证不过要修复后再收尾。'
  + '结束时用一段「summary」总结做了什么、验证结果与关键产物（文件路径等）；不要反问，不要输出无关寒暄。';

check('① 非军团任务型 Worker 的 system 与迁移前逐字节相同（零回归判据）', () => {
  assert.strictEqual(buildWorkerSystemPrompt({ chatOnly: false, ownerMember: null }), LEGACY_TASK);
});

check('① 非军团对话型 Worker 的 system 与迁移前逐字节相同', () => {
  assert.strictEqual(buildWorkerSystemPrompt({ chatOnly: true, ownerMember: null }), LEGACY_CHAT);
});

check('① 名册里没有名字的成员 ⇒ 身份段为空（不发明身份，字节不变）', () => {
  assert.strictEqual(buildWorkerSystemPrompt({ chatOnly: false, ownerMember: { id: 'm1', name: '' } }), LEGACY_TASK);
  assert.strictEqual(buildWorkerSystemPrompt({ chatOnly: false, ownerMember: { id: 'm1' } }), LEGACY_TASK);
});

// ── ② 有名成员：追加身份段（成员名进首条 system） ──
check('② 有名成员时任务型 system 追加身份段（含成员名）', () => {
  const s = buildWorkerSystemPrompt({ chatOnly: false, ownerMember: { id: 'm1', name: '前端工程师' } });
  assert.ok(s.startsWith(LEGACY_TASK), '通用串被改动（应是「原文 + 追加」）');
  assert.ok(s.includes('你是「前端工程师」——本军团的一名成员'), '身份段缺失或措辞漂移');
  assert.ok(s.length > LEGACY_TASK.length, '没有实际追加');
});

check('② 有名成员时对话型 system 也追加身份段', () => {
  const s = buildWorkerSystemPrompt({ chatOnly: true, ownerMember: { id: 'm1', name: '报数员' } });
  assert.ok(s.startsWith(LEGACY_CHAT));
  assert.ok(s.includes('你是「报数员」'));
});

check('② 成员名超长被截断到 MEMBER_NAME_MAX', () => {
  const long = '甲'.repeat(200);
  const s = memberIdentitySuffix({ name: long });
  assert.strictEqual(s, `你是「${'甲'.repeat(MEMBER_NAME_MAX)}」——本军团的一名成员，以上是分配给你的子任务。`);
});

// ── ② resolveOwnerMember：反查口径与失败降级 ──
check('② 未认领任务 ⇒ null（公共 Worker 身份）', () => {
  assert.strictEqual(resolveOwnerMember({ group: {}, task: {}, deps: {} }), null);
  assert.strictEqual(resolveOwnerMember({ group: {}, task: { ownerMemberId: '' }, deps: {} }), null);
});

check('② 按 ownerMemberId 从名册反查（命中/未命中）', () => {
  const roster = [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }];
  const deps = { resolveTeamRoster: () => roster };
  assert.strictEqual(resolveOwnerMember({ group: { g: 1 }, task: { ownerMemberId: 'b' }, deps })?.name, '乙');
  assert.strictEqual(resolveOwnerMember({ group: { g: 1 }, task: { ownerMemberId: 'zzz' }, deps }), null);
});

check('② 名册反查抛错 ⇒ null 且不外抛（绝不失败整轮）', () => {
  const deps = { resolveTeamRoster: () => { throw new Error('store down'); } };
  assert.strictEqual(resolveOwnerMember({ group: {}, task: { ownerMemberId: 'a' }, deps }), null);
});

check('② deps 没有 resolveTeamRoster / 名册非数组 ⇒ null', () => {
  assert.strictEqual(resolveOwnerMember({ group: {}, task: { ownerMemberId: 'a' }, deps: {} }), null);
  assert.strictEqual(resolveOwnerMember({ group: {}, task: { ownerMemberId: 'a' }, deps: { resolveTeamRoster: () => 'nope' } }), null);
});

// ── ③ 接线（源码形态断言，配合上方行为断言构成完整语义） ──
const src = fs.readFileSync(path.join(ROOT, 'main/workerPool.js'), 'utf8');

// 片段长度自检：防「截到空串却匹配成功」的空过（空过比红危险）
const snippet = (anchor, len) => {
  const i = src.indexOf(anchor);
  assert.ok(i > 0, `找不到装配点：${anchor}`);
  const seg = src.slice(i, i + len);
  assert.ok(seg.length >= len, '装配片段被截断（长度自检失败）');
  return seg;
};

check('③ workerPool 调用了 resolveOwnerMember（反查口径同源）', () => {
  const seg = snippet('const ownerMember = resolveOwnerMember({ group, task, deps });', 80);
  assert.ok(/resolveOwnerMember\(\{ group, task, deps \}\)/.test(seg), '反查参数不完整');
});

check('③ workerPool 用 buildWorkerSystemPrompt 组装首条 system', () => {
  const seg = snippet('systemPrompt: buildWorkerSystemPrompt({ chatOnly, ownerMember }),', 80);
  assert.ok(/chatOnly/.test(seg) && /ownerMember/.test(seg), '两个分支参数缺失');
});

check('③ per-bot 配置装配点未被本次拆分改坏（applyMemberRuntimeConfig 仍在）', () => {
  assert.ok(src.includes('applyMemberRuntimeConfig(runOpts, { group, task, deps })'),
    'applyMemberRuntimeConfig 调用丢失——成员模型/人格/技能/治理会全部失效');
});

console.log(`\nworker-identity: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

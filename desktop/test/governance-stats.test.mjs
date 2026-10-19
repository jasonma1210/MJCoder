#!/usr/bin/env node
// N9 门禁：治理开关的命中率观测落点（hook / 意图预热 / 技能按需加载）
//
// 背景（第六轮审查 §3 N9）：三个治理开关此前只有零散 console.log，没有任何**可读取**的
// 命中率落点 ⇒ 无法回答「开关是否真的在生效」，与 N2 同属「无可观测 = 无门禁」。
//
// 本套件锁四件事：
//   A. 计数器原语：incr / snapshot / reset 行为（纯内存，不落盘）；
//   B. hook 落点：pre/post 的 runs / denied / unavailable 真实累加（含「配了却没生效」信号）；
//   C. 技能落点：loadSkillContents 的 requested / loaded / missed；
//   D. 接线反模式断言：三处落点 + IPC 出口 + diagExport 消费方均在册（防「加了计数却无人读」）。
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = DESKTOP;
const { createGovernanceStats, governanceStats } = require(path.join(DESKTOP, 'main/governanceStats.js'));
const { createToolHookRunner } = require(path.join(DESKTOP, 'main/toolHooks.js'));
const { loadSkillContents } = require(path.join(DESKTOP, 'main/skills.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const cleanups = [];
function tmpFile(tag) {
  const p = path.join(os.tmpdir(), `mjc-gov-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  cleanups.push(p);
  return p;
}

// 假执行器：按命令名返回预置结果（与 tool-hooks.test.mjs 同形）
function makeExec(behavior) {
  return async ({ command }) => {
    const b = behavior[command];
    if (!b) return { failed: false, code: 0, stdout: '', stderr: '' };
    if (typeof b === 'function') return b({ command });
    return b;
  };
}

// ── A. 计数器原语 ─────────
{
  const s = createGovernanceStats();
  s.incr('b', 'k');
  s.incr('b', 'k');
  s.incr('b', 'k2', 5);
  const snap = s.snapshot();
  check('A1 incr 累加', snap.b.k === 2 && snap.b.k2 === 5, JSON.stringify(snap));
  check('A2 空 key 不污染快照', (s.incr('b', ''), s.snapshot().b[''] === undefined));
  check('A3 非法 n 回落为 1', (s.incr('b', 'k3', NaN), s.snapshot().b.k3 === 1));
  const before = s.snapshot();
  before.b.k = 999; // 改快照不应影响内部态（深拷贝）
  check('A4 snapshot 是深拷贝（外部改动不回写）', s.snapshot().b.k === 2);
  s.reset();
  check('A5 reset 清空', Object.keys(s.snapshot()).length === 0);
}

// ── B. hook 落点 ─────────
{
  // B1：pre 放行 + post 观察
  const s1 = createGovernanceStats();
  const r1 = createToolHookRunner({
    filePath: tmpFile('b1'), stats: s1, log: () => {},
    execHook: makeExec({
      'ok.sh': { failed: false, code: 0, stdout: '', stderr: '' },
      'post.sh': { failed: false, code: 0, stdout: '', stderr: '' },
    }),
  });
  r1.save([
    { name: 'gate', event: 'preToolUse', match: '*', command: 'ok.sh' },
    { name: 'audit', event: 'postToolUse', match: '*', command: 'post.sh' },
  ]);
  const calls = [];
  await r1.wrap({ writeFile: async (a) => { calls.push(a); return { ok: true }; } })
    .writeFile({ path: '/x/a.js' });
  const b1 = s1.snapshot().hooks || {};
  // 注意：快照只含「已发生过的」键（未发生不落 0），故用 `|| 0` 归一。
  check('B1 pre 放行：pre.runs=1 / denied=0 / unavailable=0',
    b1['pre.runs'] === 1 && (b1['pre.denied'] || 0) === 0 && (b1['pre.unavailable'] || 0) === 0, JSON.stringify(b1));
  check('B1 post 观察：post.runs=1 / unavailable=0',
    b1['post.runs'] === 1 && (b1['post.unavailable'] || 0) === 0);
  check('B1 工具照常执行（放行语义未被观测破坏）', calls.length === 1);
}
{
  // B2：pre 拦截
  const s2 = createGovernanceStats();
  const r2 = createToolHookRunner({
    filePath: tmpFile('b2'), stats: s2, log: () => {},
    execHook: makeExec({ 'deny.sh': { failed: false, code: 1, stdout: '', stderr: '禁止' } }),
  });
  r2.save([{ name: 'env-guard', event: 'preToolUse', match: '*', command: 'deny.sh' }]);
  let called = 0;
  const res = await r2.wrap({ writeFile: async () => { called += 1; return { ok: true }; } }).writeFile({});
  const b2 = s2.snapshot().hooks || {};
  check('B2 pre 拦截：pre.runs=1 / denied=1，工具不被调用',
    b2['pre.runs'] === 1 && b2['pre.denied'] === 1 && called === 0 && res.blockedByHook === true, JSON.stringify(b2));
}
{
  // B3：pre 不可用（超时）→ fail-open 放行，但计入 unavailable（治理开关「配了却没生效」）
  const s3 = createGovernanceStats();
  const r3 = createToolHookRunner({
    filePath: tmpFile('b3'), stats: s3, log: () => {},
    execHook: makeExec({ 'slow.sh': { failed: true, timedOut: true, code: null, stdout: '', stderr: '' } }),
  });
  r3.save([{ name: 'slow', event: 'preToolUse', match: '*', command: 'slow.sh' }]);
  let called3 = 0;
  const res3 = await r3.wrap({ readFile: async () => { called3 += 1; return { ok: true }; } }).readFile({});
  const b3 = s3.snapshot().hooks || {};
  check('B3 pre 不可用：runs=1 / unavailable=1，且 fail-open 放行',
    b3['pre.runs'] === 1 && b3['pre.unavailable'] === 1 && (b3['pre.denied'] || 0) === 0
      && called3 === 1 && res3.ok === true, JSON.stringify(b3));
}
{
  // B4：post 不可用
  const s4 = createGovernanceStats();
  const r4 = createToolHookRunner({
    filePath: tmpFile('b4'), stats: s4, log: () => {},
    execHook: makeExec({ 'bad.sh': { failed: true, code: null, stdout: '', stderr: '' } }),
  });
  r4.save([{ name: 'bad', event: 'postToolUse', match: '*', command: 'bad.sh' }]);
  const original = { ok: true, content: 'RAW' };
  const res4 = await r4.wrap({ readFile: async () => original }).readFile({});
  const b4 = s4.snapshot().hooks || {};
  check('B4 post 不可用：post.runs=1 / unavailable=1，结果不被改写',
    b4['post.runs'] === 1 && b4['post.unavailable'] === 1 && res4 === original, JSON.stringify(b4));
}
{
  // B5：零开销路径——无 hooks 配置时不产生任何计数（wrap 原样返回）
  const s5 = createGovernanceStats();
  const r5 = createToolHookRunner({ filePath: tmpFile('b5'), stats: s5, log: () => {}, execHook: makeExec({}) });
  const h = { readFile: async () => ({ ok: true }) };
  check('B5 无 hooks：wrap 原样返回且快照为空',
    r5.wrap(h) === h && Object.keys(s5.snapshot()).length === 0);
}

// ── C. 技能按需加载落点 ─────────
{
  governanceStats.reset(); // 进程内单例：清空后断言绝对值（本套件独占该进程）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjc-skills-'));
  cleanups.push(dir);
  fs.mkdirSync(path.join(dir, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n# Demo\n');
  const out = loadSkillContents(dir, ['demo', 'missing-skill']);
  const sk = governanceStats.snapshot().skills || {};
  check('C1 loaded 命中 1 个技能内容', out.length === 1 && out[0].name === 'demo');
  check('C2 requested/loaded/missed 落点正确',
    sk.requested === 2 && sk.loaded === 1 && sk.missed === 1, JSON.stringify(sk));
  // C3：空请求不计数（避免无谓噪声）
  const before = JSON.stringify(governanceStats.snapshot().skills);
  loadSkillContents(dir, []);
  check('C3 空请求不产生计数', JSON.stringify(governanceStats.snapshot().skills) === before);
}

// ── D. 接线反模式断言（防「加了计数却无人读」）────────
{
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const agentRunner = read('main/agentRunner.js');
  const toolHooks = read('main/toolHooks.js');
  const skills = read('main/skills.js');
  const localData = read('main/ipc/localData.js');
  const preload = read('main/preload.js');
  const diagExport = read('main/diagExport.js');

  check('D1 toolHooks 落点：pre.runs / pre.denied / pre.unavailable / post.runs / post.unavailable',
    /stats\.incr\('hooks', 'pre\.runs'\)/.test(toolHooks)
      && /stats\.incr\('hooks', 'pre\.denied'\)/.test(toolHooks)
      && /stats\.incr\('hooks', 'pre\.unavailable'\)/.test(toolHooks)
      && /stats\.incr\('hooks', 'post\.runs'\)/.test(toolHooks)
      && /stats\.incr\('hooks', 'post\.unavailable'\)/.test(toolHooks));
  check('D2 agentRunner 落点：intentPrewarm runs/connected/toolsAdded/misses',
    /governanceStats\.incr\('intentPrewarm', 'runs'\)/.test(agentRunner)
      && /governanceStats\.incr\('intentPrewarm', 'connected'/.test(agentRunner)
      && /governanceStats\.incr\('intentPrewarm', 'toolsAdded'/.test(agentRunner)
      && /governanceStats\.incr\('intentPrewarm', 'misses'\)/.test(agentRunner));
  check('D2b agentRunner 区分 noIntent / nativeCovered / satisfied（同为空数组但含义不同）',
    /governanceStats\.incr\('intentPrewarm', 'noIntent'\)/.test(agentRunner)
      && /governanceStats\.incr\('intentPrewarm', 'nativeCovered'\)/.test(agentRunner)
      && /governanceStats\.incr\('intentPrewarm', 'satisfied'\)/.test(agentRunner));
  check('D3 skills 落点：requested/loaded/missed',
    /incr\('skills', 'requested'/.test(skills)
      && /incr\('skills', 'loaded'/.test(skills)
      && /incr\('skills', 'missed'/.test(skills));
  check('D4 IPC 只读出口 governance:stats 已注册',
    /ipcMain\.handle\('governance:stats'/.test(localData));
  check('D5 preload 暴露 governanceStats',
    /governanceStats: \(\) => ipcRenderer\.invoke\('governance:stats'\)/.test(preload));
  check('D6 diagExport 消费方：governance/stats.json 随诊断包导出',
    /governance\/stats\.json/.test(diagExport) && /governanceStats\.snapshot\(\)/.test(diagExport));
  check('D7 计数器为纯内存（不落盘）：无 fs 写入依赖',
    !/require\('fs'\)/.test(read('main/governanceStats.js')));
}

for (const c of cleanups) {
  try { fs.rmSync(c, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
}

console.log(`\ngovernance-stats: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;

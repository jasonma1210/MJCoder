// F-020 回归门禁：数字员工 rolePreset 的审批档/沙箱钳制在**两条通道必须同源**。
//
// 事故形状（第七轮审查 F-020）：`agent:run` 有主进程通道与进程内回退通道。
// 主进程通道（main/agentRunner.js「if (payload.rolePreset)」段）对角色声明取「更严格者」，
// 回退通道（renderer/src/lib/agent.js 的 runAgentInProcess）此前**一处钳制都没有**
// ⇒ 同一份 rolePreset 在主通道收紧审批、在回退通道放开审批。
// 这不是纸面差异：回退路径在旧版 preload、纯 Node 测试环境下真实可走。
//
// 本门禁守三层：
//   A. 行为：更严生效 / 更宽不放宽 / 无 rolePreset 不变（applyRoleClamp 真函数）
//   B. 接线：runAgentInProcess 体内**确实调用**了 applyRoleClamp（防「helper 写了但没接」，
//      这是本项目反复踩过的坑：单测直调 helper 全绿、真机路径没用上）
//   C. 对账：shared/roleClamp.mjs（ESM，渲染层用）与 main/approvalPolicy.js（CJS，主进程用）
//      在全枚举组合上逐值相等。两份实现是模块制式所迫（`.mjs` 无法被 CJS 同步 require，
//      CJS 的 module.exports 也无法在浏览器端执行），所以漂移必须由门禁挡住而不是靠自觉。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import {
  stricterApproval,
  stricterSandbox,
  normalizeApprovalMode,
  normalizeSandboxPolicy,
  APPROVAL_ORDER,
  SANDBOX_ORDER,
} from '../shared/roleClamp.mjs';
import { applyRoleClamp } from '../renderer/src/lib/agent.js';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 主进程侧的一份（CJS）：ESM 可以 import CJS，default 即 module.exports
const mainPolicy = require('../main/approvalPolicy.js');

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: 期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);
}
// 剥掉注释后再做结构断言：否则「把调用注释掉」仍能通过正则（注释里留着同样的文本），
// 门禁沦为「出现过这串字符就算活着」的假绿。
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += d === undefined ? '' : d; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1; continue;
    }
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2; continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; out += c; i += 1; continue; }
    out += c; i += 1;
  }
  return out;
}
function readCode(rel) {
  const p = path.join(DESKTOP, rel);
  if (!fs.existsSync(p)) throw new Error(`文件不存在：${rel}`);
  return stripComments(fs.readFileSync(p, 'utf8'));
}

// ── A. 行为：钳制方向正确 ────────────────────────────────────────────────
check('A1 角色更严格时取角色值（审批 always / 沙箱 read-only）——断了则回退通道仍是宽松档', () => {
  const out = applyRoleClamp({
    approvalMode: 'auto-safe',
    sandboxPolicy: 'workspace-write',
    rolePreset: { approvalMode: 'always', sandboxPolicy: 'read-only' },
  });
  eq(out.approvalMode, 'always', '审批档');
  eq(out.sandboxPolicy, 'read-only', '沙箱档');
});

check('A2 角色更宽松时**不得放宽**用户设置（取更严格者）——断了则员工可反向放大用户权限', () => {
  const out = applyRoleClamp({
    approvalMode: 'always',
    sandboxPolicy: 'read-only',
    rolePreset: { approvalMode: 'never', sandboxPolicy: 'full-access' },
  });
  eq(out.approvalMode, 'always', '审批档不得被放宽');
  eq(out.sandboxPolicy, 'read-only', '沙箱档不得被放宽');
});

check('A3 角色与用户档相同时保持原值（幂等，不多余改写）', () => {
  const out = applyRoleClamp({
    approvalMode: 'on-request',
    sandboxPolicy: 'workspace-write',
    rolePreset: { approvalMode: 'on-request', sandboxPolicy: 'workspace-write' },
  });
  eq(out.approvalMode, 'on-request', '审批档');
  eq(out.sandboxPolicy, 'workspace-write', '沙箱档');
});

check('A4 无 rolePreset 时原样返回同一对象（不补默认档 ⇒ 行为与既往完全一致）', () => {
  const input = { approvalMode: 'auto-safe', sandboxPolicy: 'full-access', messages: [] };
  const out = applyRoleClamp(input);
  if (out !== input) throw new Error('无 rolePreset 时应原样返回同一引用（不得凭空注入默认档）');
  eq(out.approvalMode, 'auto-safe', '审批档未被改写');
  eq(out.sandboxPolicy, 'full-access', '沙箱档未被改写');
  eq(applyRoleClamp(undefined), undefined, 'undefined 入参');
});

check('A5 不修改调用方入参（回退路径 options 由 useAgentRun 构造，原地改写会污染本轮其余取值）', () => {
  const input = {
    approvalMode: 'auto-safe',
    sandboxPolicy: 'workspace-write',
    rolePreset: { approvalMode: 'always', sandboxPolicy: 'read-only' },
  };
  const out = applyRoleClamp(input);
  eq(input.approvalMode, 'auto-safe', '入参 approvalMode 被就地改写');
  eq(input.sandboxPolicy, 'workspace-write', '入参 sandboxPolicy 被就地改写');
  eq(out.approvalMode, 'always', '返回值审批档');
});

check('A6 非法/未知档位不放大权限（归一化后再比较，与主进程同纪律）', () => {
  // 用户侧非法 → 收敛到默认档；角色侧更严则按角色收紧
  eq(applyRoleClamp({ approvalMode: 'INVALID', rolePreset: { approvalMode: 'always' } }).approvalMode, 'always', '非法用户档 + 严角色档');
  eq(applyRoleClamp({ approvalMode: 'INVALID', rolePreset: { approvalMode: 'never' } }).approvalMode, 'on-request', '非法用户档 + 宽角色档（不得低于默认 on-request）');
  eq(applyRoleClamp({ sandboxPolicy: 'INVALID', rolePreset: { sandboxPolicy: 'full-access' } }).sandboxPolicy, 'workspace-write', '非法沙箱档 + 宽角色档（不得放到 full-access）');
  // 角色侧非法同样按默认档参与比较，不越界
  eq(applyRoleClamp({ approvalMode: 'auto-safe', rolePreset: { approvalMode: 'BOGUS' } }).approvalMode, 'on-request', '非法角色档按默认 on-request 参与比较');
});

check('A7 rolePreset 存在但未声明审批/沙箱时等价于「不额外约束」（与主进程同形状）', () => {
  // 主进程侧：stricterApproval(user, undefined) 直接返回 user（不归一、不改写）——
  // 回退路径必须同形状，否则「角色只填了 systemPrompt」也会顺手改写用户档位。
  const out = applyRoleClamp({ approvalMode: 'auto-safe', sandboxPolicy: 'read-only', rolePreset: { systemPrompt: 'x' } });
  eq(out.approvalMode, 'auto-safe', '未声明审批档时不得改写用户档');
  eq(out.sandboxPolicy, 'read-only', '未声明沙箱时不得改写用户策略');
  eq(out.approvalMode, mainPolicy.stricterApproval('auto-safe', undefined), '与 main 侧取值一致');
  eq(out.sandboxPolicy, mainPolicy.stricterSandbox('read-only', undefined), '与 main 侧取值一致');
});

// ── B. 接线：回退路径真的调用了钳制 ──────────────────────────────────────
check('B1 runAgentInProcess 体内确实调用 applyRoleClamp（断了则 helper 沦为装饰，回退通道仍不钳制）', () => {
  const src = readCode('renderer/src/lib/agent.js');
  const start = src.indexOf('function runAgentInProcess(');
  if (start < 0) throw new Error('agent.js 中找不到 runAgentInProcess（改名/重构后本门禁需同步）');
  const body = src.slice(start);
  const coreCall = body.match(/coreRunAgent\(([\s\S]*?)\);/);
  if (!coreCall) throw new Error('runAgentInProcess 里找不到 coreRunAgent(...) 调用');
  if (!/applyRoleClamp\(/.test(coreCall[1])) {
    throw new Error('coreRunAgent 的实参里没有 applyRoleClamp(...) —— 回退通道未钳制 rolePreset');
  }
});

check('B2 agent.js 从 shared/roleClamp.mjs 静态引入（不得内联第二份实现）', () => {
  const src = readCode('renderer/src/lib/agent.js');
  if (!/from '\.\.\/\.\.\/\.\.\/shared\/roleClamp\.mjs'/.test(src)) {
    throw new Error('agent.js 未从 ../../../shared/roleClamp.mjs 引入钳制函数');
  }
  if (/function stricterApproval|function stricterSandbox/.test(src)) {
    throw new Error('agent.js 内联了 stricterApproval/stricterSandbox 定义 —— 会出现第三份实现');
  }
});

// ── C. 对账：两份实现逐值相等（模块制式所迫的镜像，靠门禁挡漂移）──────────
check('C1 常量与归一化函数逐值相等（roleClamp.mjs ↔ main/approvalPolicy.js）', () => {
  if (JSON.stringify(APPROVAL_ORDER) !== JSON.stringify(mainPolicy.APPROVAL_ORDER)) {
    throw new Error(`APPROVAL_ORDER 不一致：${JSON.stringify(APPROVAL_ORDER)} vs ${JSON.stringify(mainPolicy.APPROVAL_ORDER)}`);
  }
  if (JSON.stringify(SANDBOX_ORDER) !== JSON.stringify(mainPolicy.SANDBOX_ORDER)) {
    throw new Error(`SANDBOX_ORDER 不一致：${JSON.stringify(SANDBOX_ORDER)} vs ${JSON.stringify(mainPolicy.SANDBOX_ORDER)}`);
  }
  const probes = [...Object.keys(APPROVAL_ORDER), '', undefined, null, 'INVALID', 'ALWAYS'];
  for (const v of probes) {
    eq(normalizeApprovalMode(v), mainPolicy.normalizeApprovalMode(v), `normalizeApprovalMode(${String(v)})`);
    eq(normalizeSandboxPolicy(v), mainPolicy.normalizeSandboxPolicy(v), `normalizeSandboxPolicy(${String(v)})`);
  }
});

check('C2 stricterApproval 全矩阵（5×5 + 未知值/空值）逐值相等——漂移即红', () => {
  const vals = [...Object.keys(APPROVAL_ORDER), '', undefined, null, 'INVALID'];
  let combos = 0;
  for (const user of vals) {
    for (const role of vals) {
      combos++;
      eq(stricterApproval(user, role), mainPolicy.stricterApproval(user, role),
        `stricterApproval(${String(user)}, ${String(role)})`);
    }
  }
  if (combos < 64) throw new Error(`矩阵覆盖不足：只跑了 ${combos} 组`);
});

check('C3 stricterSandbox 全矩阵（3×3 + 未知值/空值）逐值相等——漂移即红', () => {
  const vals = [...Object.keys(SANDBOX_ORDER), '', undefined, null, 'INVALID'];
  let combos = 0;
  for (const user of vals) {
    for (const role of vals) {
      combos++;
      eq(stricterSandbox(user, role), mainPolicy.stricterSandbox(user, role),
        `stricterSandbox(${String(user)}, ${String(role)})`);
    }
  }
  if (combos < 36) throw new Error(`矩阵覆盖不足：只跑了 ${combos} 组`);
});

// 2026-10-21（第八轮 D-808）：钳制语句从 agentRunner 内联**收敛**到 rolePresetApply，
// 主会话与 Worker 共用一份。断言随之改为「两段合并成立」：
//   ① agentRunner 仍把 payload.rolePreset 交给 applyRolePreset（委托没断）；
//   ② rolePresetApply 里确实还有那两条取更严语句（钳制本身没丢）。
// 任一段缺失都仍然判红 —— 这不是放宽，而是把同一个不变量钉在新位置上。
check('C4 主进程 agentRunner 仍从 approvalPolicy 取钳制函数（主通道不得被本次改动波及）', () => {
  const src = readCode('main/agentRunner.js');
  if (!/const \{ stricterApproval, stricterSandbox \} = require\('\.\/approvalPolicy'\)/.test(src)) {
    throw new Error('agentRunner.js 的钳制函数来源变了（本任务要求主通道行为完全不变）');
  }
  if (!/applyRolePreset\(engineParams, payload\.rolePreset,/.test(src)) {
    throw new Error('agentRunner.js 不再把 payload.rolePreset 委托给 applyRolePreset（钳制链断了）');
  }
  const helper = readCode('main/rolePresetApply.js');
  if (!/engineParams\.approvalMode = stricterApproval\(engineParams\.approvalMode, rolePreset\.approvalMode\)/.test(helper)) {
    throw new Error('rolePresetApply.js 的审批钳制语句不见了');
  }
  if (!/engineParams\.sandboxPolicy = stricterSandbox\(engineParams\.sandboxPolicy, rolePreset\.sandboxPolicy\)/.test(helper)) {
    throw new Error('rolePresetApply.js 的沙箱钳制语句不见了');
  }
});

if (process.exitCode === 1) console.error(`\nFAIL：${total - pass}/${total} 项失败`);
else console.log(`\nPASS：${pass}/${total} 项通过`);

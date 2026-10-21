// 第八轮 B-07 门禁：中断权限矩阵的 lead / member 分支必须**可达**
//
// 缺陷回顾：唯一注入口把 `actorKind` 硬编码为 `'user'`，于是 §9.2 的两条硬约束
// （「Lead 中断下属必须留理由」「L1 逐次确认不允许同类豁免」）在生产**永远走不到**——
// `REASON_REQUIRED` / `NEED_CONFIRM` 是死代码，`teams:interrupt` 传的 `confirmed` 没人检查。
// `team-interrupt.test.js` 里测矩阵的 38 处 check 有些测的是不可达分支，给人「已验证」的错觉。
//
// 修法：入口经 `resolveActor(payload)` 解析发起方（未声明/非法回落 user，fail-closed），
// 调用方显式声明 lead/member 时两条分支立即生效。
//
// 本套件分两段：
//   ① `resolveActor` 的解析规则（纯函数，含「回落方向」这条安全属性）；
//   ② 端到端走 `interruptTask`：用假 store 构造编制快照，验证理由/确认/归属三条判据**真的会拦**。
// 第②段是主判据——只测 `checkInterruptPermit`（纯函数）证明不了「接线通了」，
// 它本来就返回正确值，坏的是入口。
const path = require('path');
const fs = require('fs');
const teamInterrupt = require('../main/teamInterrupt');
const { checkInterruptPermit, interruptTask, resolveActor, initTeamInterrupt } = teamInterrupt;

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── ① resolveActor：默认值方向 / 白名单 / 组合清理 ──
{
  check('B-07 未声明 actorKind ⇒ user（用户点按钮发起的通道，默认必须是最宽主体）',
    resolveActor({}).actorKind === 'user');
  check('B-07 非法值 ⇒ user（渲染层版本错位不得让用户的中断被拒）',
    resolveActor({ actorKind: 'admin' }).actorKind === 'user');
  check('B-07 显式 lead 透传（分支可达的前提）',
    resolveActor({ actorKind: 'lead', actorMemberId: 'm1' }).actorKind === 'lead');
  check('B-07 显式 member 透传并保留 actorMemberId',
    resolveActor({ actorKind: 'member', actorMemberId: 'm2' }).actorMemberId === 'm2');
  check('B-07 user 主体清空 actorMemberId（审计串不得自相矛盾）',
    resolveActor({ actorKind: 'user', actorMemberId: 'm9' }).actorMemberId === null);
  check('B-07 空 payload 不抛异常', (() => { try { resolveActor(null); return true; } catch { return false; } })());
}

// ── 假 store：编制快照 + 两个任务 ──
const ROSTER = [
  { id: 'boss', name: '统筹', roleKind: 'lead' },
  { id: 'm1', name: '成员一', roleKind: 'member' },
  { id: 'm2', name: '成员二', roleKind: 'member' },
];
function makeWorld({ status = 'running' } = {}) {
  const tasks = [
    { taskId: 't1', title: '任务一', status, ownerMemberId: 'm1' },
    { taskId: 't2', title: '任务二', status, ownerMemberId: 'm2' },
  ];
  const aborted = [];
  const messages = [];
  const store = {
    getGroup: (runId) => (runId === 'run-1' ? { group_id: 'run-1', dag: { roster: ROSTER } } : null),
    listTasks: () => tasks.map((t) => ({ ...t })),
    setTaskStatus: (runId, taskId, s) => {
      const t = tasks.find((x) => x.taskId === taskId);
      if (t) t.status = s;
      return true;
    },
    settleWaitingTasks: () => [],
  };
  initTeamInterrupt({
    getTaskStore: () => store,
    getTeamStore: () => ({ getTeam: () => ({ id: 'team-1', members: ROSTER }) }),
    workerPool: { abortTask: (runId, taskId) => { aborted.push(taskId); return true; } },
    postMessage: (m) => { messages.push(m); return { ok: true }; },
  });
  return { aborted, messages };
}

// ── ② 端到端：lead 分支的两条硬约束真的拦得住 ──
{
  makeWorld();
  const noReason = interruptTask({ teamId: 'team-1', runId: 'run-1', taskId: 't1', actorKind: 'lead', actorMemberId: 'boss' });
  check('B-07 lead 无理由 ⇒ REASON_REQUIRED（改前这条判据永远不会被执行）',
    noReason.ok === false && noReason.code === 'REASON_REQUIRED', JSON.stringify(noReason));

  const noConfirm = interruptTask({
    teamId: 'team-1', runId: 'run-1', taskId: 't1', actorKind: 'lead', actorMemberId: 'boss', reason: '方向不对',
  });
  check('B-07 lead 有理由但未确认 ⇒ NEED_CONFIRM（L1 逐次确认，不允许同类豁免）',
    noConfirm.ok === false && noConfirm.code === 'NEED_CONFIRM', JSON.stringify(noConfirm));
}
{
  const w = makeWorld();
  const ok = interruptTask({
    teamId: 'team-1', runId: 'run-1', taskId: 't1',
    actorKind: 'lead', actorMemberId: 'boss', reason: '方向不对', confirmed: true,
  });
  check('B-07 lead 有理由 + 已确认 ⇒ 中断成功', ok.ok === true && ok.interrupted.includes('t1'), JSON.stringify(ok));
  check('B-07 lead 中断走 Worker 池唯一入口（abortTask 而非直接改状态）', w.aborted.includes('t1'));
  check('B-07 审计留痕的 actor 为 lead（改前恒为 user，语义漂移）',
    w.messages.length === 1 && w.messages[0].payload.actor === 'lead',
    JSON.stringify(w.messages[0]?.payload || {}));
  check('B-07 审计留痕带理由', String(w.messages[0]?.payload?.reason || '').includes('方向不对'));
}
{
  const w = makeWorld();
  // 统筹按成员范围中断自己 ⇒ 禁止（防失控）：这是 lead 分支里最容易写反的一条
  const self = interruptTask({
    teamId: 'team-1', runId: 'run-1', targetMemberId: 'boss',
    actorKind: 'lead', actorMemberId: 'boss', reason: '自查', confirmed: true,
  });
  check('B-07 lead 成员范围自我中止 ⇒ LEAD_SELF_FORBIDDEN',
    self.ok === false && self.code === 'LEAD_SELF_FORBIDDEN', JSON.stringify(self));
  check('B-07 被拦时不产生任何中断动作', w.aborted.length === 0);
}

// ── ③ 端到端：member 分支 ──
{
  makeWorld();
  const own = interruptTask({
    teamId: 'team-1', runId: 'run-1', taskId: 't1', actorKind: 'member', actorMemberId: 'm1',
  });
  check('B-07 member 中断自己认领的任务 ⇒ 允许（且不需要理由/确认）', own.ok === true, JSON.stringify(own));

  const other = interruptTask({
    teamId: 'team-1', runId: 'run-1', taskId: 't2', actorKind: 'member', actorMemberId: 'm1',
  });
  check('B-07 member 中断他人任务 ⇒ MEMBER_NOT_OWNER',
    other.ok === false && other.code === 'MEMBER_NOT_OWNER', JSON.stringify(other));

  const byMemberScope = interruptTask({
    teamId: 'team-1', runId: 'run-1', targetMemberId: 'm2', actorKind: 'member', actorMemberId: 'm1',
  });
  check('B-07 member 按成员范围中断 ⇒ MEMBER_SCOPE_FORBIDDEN',
    byMemberScope.ok === false && byMemberScope.code === 'MEMBER_SCOPE_FORBIDDEN', JSON.stringify(byMemberScope));

  const notInRoster = interruptTask({
    teamId: 'team-1', runId: 'run-1', taskId: 't1', actorKind: 'member', actorMemberId: 'ghost',
  });
  check('B-07 非在册主体 ⇒ ACTOR_NOT_IN_ROSTER', notInRoster.ok === false && notInRoster.code === 'ACTOR_NOT_IN_ROSTER');
}

// ── ④ user 主体不受 lead 约束（回归：放开入参不得顺手收紧用户）──
{
  const w = makeWorld();
  const r = interruptTask({ teamId: 'team-1', runId: 'run-1', taskId: 't1', reason: '', confirmed: false });
  check('B-07 未声明主体（= user）无需理由与确认即可中断', r.ok === true, JSON.stringify(r));
  check('B-07 user 留痕 actor 为 user', w.messages[0]?.payload?.actor === 'user');
}

// ── ⑤ 矩阵纯函数自检（防端到端全绿但矩阵本身被改坏）──
{
  const leadSelf = checkInterruptPermit({ actorKind: 'lead', actorMemberId: 'boss', actorRoleKind: 'lead', targetOwnerId: 'boss', scope: 'member' });
  const leadOther = checkInterruptPermit({ actorKind: 'lead', actorMemberId: 'boss', actorRoleKind: 'lead', targetOwnerId: 'm1', scope: 'member' });
  const notLead = checkInterruptPermit({ actorKind: 'lead', actorMemberId: 'm1', actorRoleKind: 'member', targetOwnerId: 'm2', scope: 'task' });
  check('B-07 矩阵：lead 自我中止禁止 / 停他人允许 / 冒充 lead 拒绝',
    !leadSelf.ok && leadOther.ok && !notLead.ok,
    `${leadSelf.code}/${leadOther.code || 'ok'}/${notLead.code}`);
}

// ── ⑥ 接线：main.js 不得再硬编码 actorKind ──
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8');
  check('B-07 接线：interruptTask 经 resolveActor 解析主体',
    /interruptTask:\s*\(p\)\s*=>\s*teamInterrupt\.interruptTask\(\{\s*\.\.\.p,\s*\.\.\.teamInterrupt\.resolveActor\(p\)/.test(src));
  check('B-07 接线：已无 actorKind 硬编码', !/interruptTask\(\{\s*\.\.\.p,\s*actorKind:\s*'user'\s*\}\)/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
// 断言计数自检（防空过）：本文件至少 18 条断言，缺一条说明有段被跳过
if (pass + fail < 18) { console.log('❌ 断言数不足（疑似某段被跳过）'); process.exit(1); }
process.exit(fail === 0 ? 0 : 1);

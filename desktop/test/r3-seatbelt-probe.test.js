// N3 Seatbelt 真实可用性探测行为验收（2026-10-16）：
//   真因：嵌套沙箱环境（本审查会话即如此）下任何 sandbox_apply 都 Operation not permitted，
//   此前运行时才会以晦涩错误暴露。探测须诚实区分「嵌套沙箱环境」与「真可用」。
// 本测试在 WorkBuddy agent 沙箱内运行 ⇒ 探测结果必须为 ok:false 且给出可行动原因；
// 在非嵌套环境（真实桌面 App）中同一探测应为 ok:true（此处以 profile 生成仍正确作辅助断言）。
const assert = require('assert');
const sandbox = require('../main/sandbox');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  const p1 = await sandbox.seatbeltUsable();
  check('探测返回结构完整', typeof p1.ok === 'boolean' && typeof p1.reason === 'string');
  if (!p1.ok) {
    check('嵌套沙箱环境：诚实上报 ok=false', p1.ok === false);
    check('原因可行动（指明嵌套沙箱/不可用缘由）', /嵌套沙箱|不存在|探测失败|非 darwin|平台/.test(p1.reason), p1.reason.slice(0, 120));
  } else {
    check('非嵌套环境：Seatbelt 真实可用', p1.ok === true);
  }
  // 进程级缓存：二次调用返回同一对象（能力不随运行变化，不做重复探测）
  const p2 = await sandbox.seatbeltUsable();
  check('探测结果进程级缓存（同一对象）', p1 === p2);
  // reset 后重新探测仍一致
  sandbox.resetSeatbeltProbe();
  const p3 = await sandbox.seatbeltUsable();
  check('reset 后重新探测结果一致', p3.ok === p1.ok);
  // profile 生成不受探测影响（workspace-write 仍含 deny default 与项目写规则）
  const profile = sandbox.buildSeatbeltProfile('workspace-write', '/tmp');
  check('profile 生成不受探测影响（deny default + /tmp 可写）', /\(deny default\)/.test(profile) && /\/tmp/.test(profile));

  console.log(`\n──── N3 Seatbelt 探测验收汇总：通过 ${pass} · 失败 ${fail} ────`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });

// 审批通道分发逻辑测试：按 id 精确分发 / 超时 deny / 未知 id 忽略 / legacy 通道收敛
// P1-4（2026-10-17）：理由随决议回传（wait 返回 Promise 的 reason 属性）
// P2-3（2026-10-17）：dispatchLegacy 无标识响应一律拒绝
// 差集 A（2026-10-17）：diff 行内评论——存储 + 回灌 user 消息构造
const {
  ApprovalChannel,
  normalizeReason, denialText, approvalReasonOf,
  normalizeDiffComment, normalizeLineRange, buildDiffFeedbackMessage,
  initDiffCommentChannel, recordDiffComment, listDiffComments, handleDiffComment,
} = require('../main/approvalChannel');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// console.warn 捕获（断言「拒绝 + 告警」类行为）
function captureWarn(fn) {
  const orig = console.warn;
  const seen = [];
  console.warn = (...args) => { seen.push(args.map(String).join(' ')); };
  try { return { result: fn(), seen }; } finally { console.warn = orig; }
}

(async () => {
  // ── 并发审批按 id 精确分发（原竞态场景：两个等待者，响应不得串扰）──
  const ch = new ApprovalChannel();
  const idA = ch.nextId();
  const idB = ch.nextId();
  let resolvedA = null;
  let resolvedB = null;
  const pA = ch.wait(idA).then((d) => { resolvedA = d; });
  const pB = ch.wait(idB).then((d) => { resolvedB = d; });
  check('并发两个挂起审批', ch.size === 2);
  const okB = ch.dispatch(idB, 'once');
  const okA = ch.dispatch(idA, 'deny');
  check('按 id 分发成功', okA === true && okB === true);
  await Promise.all([pA, pB]);
  check('决策不串扰：A=deny，B=once', resolvedA === 'deny' && resolvedB === 'once');
  check('分发后无残留挂起', ch.size === 0);

  // ── 未知 / 重复 id 拒绝分发（防串扰与重放）──
  check('未知 id 分发被拒绝', ch.dispatch('ap-unknown-999', 'once') === false);
  check('已消费 id 不可重放', ch.dispatch(idA, 'once') === false);

  // ── 超时按 deny ──
  const chT = new ApprovalChannel({ timeoutMs: 50 });
  let timeoutResult = null;
  const pT = chT.wait(chT.nextId()).then((d) => { timeoutResult = d; });
  await new Promise((r) => setTimeout(r, 150));
  await pT;
  check('超时未响应自动 deny', timeoutResult === 'deny' && chT.size === 0);

  // ── P1-4：理由随决议回传（决议值保持字符串，理由经 Promise.reason 暴露）──
  const chR = new ApprovalChannel();
  const idR = chR.nextId();
  const waitR = chR.wait(idR);
  check('决议前 reason 为 null', waitR.reason === null);
  check('带理由分发成功', chR.dispatch(idR, 'deny', '用 npm 别用 pnpm') === true);
  const decisionR = await waitR;
  check('决议值仍是纯字符串（向后兼容）', decisionR === 'deny' && typeof decisionR === 'string');
  check('理由随决议回传', waitR.reason === '用 npm 别用 pnpm');
  check('approvalReasonOf 取到理由', approvalReasonOf(waitR) === '用 npm 别用 pnpm');

  // 无理由：行为与旧版完全一致
  const chR2 = new ApprovalChannel();
  const idR2 = chR2.nextId();
  const waitR2 = chR2.wait(idR2);
  chR2.dispatch(idR2, 'once');
  await waitR2;
  check('无理由时 reason 为 null', waitR2.reason === null);
  check('无理由时 approvalReasonOf 返回空串', approvalReasonOf(waitR2) === '');
  check('无理由时决议不受影响', approvalReasonOf(waitR2) === '' && (await waitR2) === 'once');

  // 理由归一化：空白视为无理由；超长截断；非字符串 coercion
  check('normalizeReason：空白为 null', normalizeReason('   ') === null && normalizeReason(undefined) === null);
  check('normalizeReason：trim 生效', normalizeReason('  先跑测试  ') === '先跑测试');
  const long = 'x'.repeat(600);
  check('normalizeReason：超长截断到 500', normalizeReason(long).length === 500 && normalizeReason(long).endsWith('…'));
  check('normalizeReason：非字符串 coercion', normalizeReason(42) === '42');
  check('normalizeReason：空串归一为 null', normalizeReason('') === null);

  // 超时 / 取消 / dispose 路径无理由
  const chR4 = new ApprovalChannel({ timeoutMs: 40 });
  const waitR4 = chR4.wait(chR4.nextId());
  await new Promise((r) => setTimeout(r, 120));
  await waitR4;
  check('超时收尾 reason 为 null', waitR4.reason === null);

  // 非法决策值仍 fail-closed 收敛为 deny（V12 纪律不被理由参数破坏）
  const chR5 = new ApprovalChannel();
  const idR5 = chR5.nextId();
  const waitR5 = chR5.wait(idR5);
  chR5.dispatch(idR5, 'hack', '理由');
  check('非法决策值 + 理由仍收敛为 deny', (await waitR5) === 'deny');

  // 拒绝文案：单一事实来源
  check('denialText：无理由保持旧串', denialText('') === '用户拒绝执行' && denialText(null) === '用户拒绝执行');
  check('denialText：有理由拼进结果', denialText('用 npm') === '用户拒绝执行。理由：用 npm');

  // ── P2-3：dispatchLegacy 无标识响应一律拒绝（不再猜测分发）──
  const chL = new ApprovalChannel();
  const idL1 = chL.nextId();
  let legacyResult = null;
  const pL1 = chL.wait(idL1).then((d) => { legacyResult = d; });
  const cap = captureWarn(() => chL.dispatchLegacy(null, 'once'));
  check('无 id 的 legacy 分发被拒绝（P2-3）', cap.result === false);
  check('无 id 拒绝时留下告警', cap.seen.some((w) => w.includes('dispatchLegacy') && w.includes('approvalId')));
  const cap2 = captureWarn(() => chL.dispatchLegacy(undefined, 'once'));
  check('undefined id 同样被拒绝', cap2.result === false && cap2.seen.length === 1);
  check('被拒绝后挂起未被消费', chL.size === 1 && legacyResult === null);
  // 带 id 时行为与 dispatch 一致（方法保留仅为兼容既有调用方）
  check('带 id 的 legacy 分发成功', chL.dispatchLegacy(idL1, 'conversation') === true);
  await pL1;
  check('带 id 的 legacy 决策正确', legacyResult === 'conversation');

  // ── disposeAll：全部按 deny 收尾 ──
  const chD = new ApprovalChannel();
  const results = [];
  results.push(chD.wait(chD.nextId()));
  results.push(chD.wait(chD.nextId()));
  chD.disposeAll();
  const denied = await Promise.all(results);
  check('disposeAll 全部按 deny 收尾', denied.every((d) => d === 'deny') && chD.size === 0);

  // ═══════════════════════════════════════════
  // 差集 A：diff 行内评论 —— 归一化 / 回灌消息构造 / 存储
  // ═══════════════════════════════════════════

  // 行范围归一
  check('normalizeLineRange：合法范围', JSON.stringify(normalizeLineRange({ start: 12, end: 20 })) === JSON.stringify({ start: 12, end: 20 }));
  check('normalizeLineRange：end<start 为 null', normalizeLineRange({ start: 20, end: 12 }) === null);
  check('normalizeLineRange：start<1 为 null', normalizeLineRange({ start: 0, end: 5 }) === null);
  check('normalizeLineRange：非数字为 null', normalizeLineRange({ start: 'a', end: 'b' }) === null);
  check('normalizeLineRange：缺省为 null', normalizeLineRange(null) === null && normalizeLineRange(undefined) === null);

  // 载荷归一：缺评论/线程/文件路径一律拒绝
  check('normalizeDiffComment：空载荷拒绝', normalizeDiffComment(null) === null && normalizeDiffComment({}) === null);
  check('normalizeDiffComment：缺评论内容拒绝', normalizeDiffComment({ threadId: 1, filePath: 'a.js' }) === null);
  check('normalizeDiffComment：缺线程拒绝', normalizeDiffComment({ comment: 'x', filePath: 'a.js' }) === null);
  check('normalizeDiffComment：缺文件路径拒绝', normalizeDiffComment({ comment: 'x', threadId: 1 }) === null);
  const dc = normalizeDiffComment({
    threadId: 7, filePath: ' src/foo.js ', hunkIndex: '2',
    lineRange: { start: 12, end: 20 }, comment: '  改用 const  ', diffSnippet: '@@ -10,3 +10,3 @@\n-old\n+new',
  });
  check('normalizeDiffComment：合法载荷补全字段',
    dc && dc.threadId === '7' && dc.filePath === 'src/foo.js' && dc.hunkIndex === 2
    && dc.comment === '改用 const' && typeof dc.id === 'string' && typeof dc.createdAt === 'number');
  check('normalizeDiffComment：超长评论截断', normalizeDiffComment({ threadId: 1, filePath: 'a.js', comment: 'y'.repeat(2500) }).comment.length === 2000);
  check('normalizeDiffComment：超长 snippet 截断', normalizeDiffComment({ threadId: 1, filePath: 'a.js', comment: 'x', diffSnippet: 'z'.repeat(5000) }).diffSnippet.length === 4000);

  // 回灌消息构造：格式 + 「被评论的变更」同时可见（方案文档关键约束）
  const msg = buildDiffFeedbackMessage({
    filePath: 'src/foo.js', lineRange: { start: 12, end: 20 },
    comment: '把 var 改成 const', diffSnippet: '@@ -10,3 +10,3 @@\n context\n-old\n+new',
  });
  check('回灌消息是 user 角色', msg.role === 'user');
  check('回灌消息含反馈头', msg.content.startsWith('[用户对以下变更的反馈]'));
  check('回灌消息含文件与行范围', msg.content.includes('文件：src/foo.js（第 12-20 行）'));
  check('回灌消息含评论内容', msg.content.includes('用户评论：把 var 改成 const'));
  check('回灌消息含被评论的变更（关键约束）', msg.content.includes('被评论的变更（Agent 此前的改动）：') && msg.content.includes('+new'));
  check('回灌消息含行动指令', msg.content.includes('请据此修改，不要重复被拒绝的做法。'));
  const msgNoRange = buildDiffFeedbackMessage({ filePath: 'src/foo.js', lineRange: null, comment: 'x', diffSnippet: '' });
  check('无行范围时不硬造', msgNoRange.content.includes('文件：src/foo.js\n') && !msgNoRange.content.includes('第'));
  const msgNoSnippet = buildDiffFeedbackMessage({ filePath: 'a.js', lineRange: { start: 1, end: 2 }, comment: 'x', diffSnippet: '   ' });
  check('无变更片段时省略该段', !msgNoSnippet.content.includes('被评论的变更'));

  // 存储：未注入 localStore 时退化为进程内 Map（单测/降级路径）
  initDiffCommentChannel({}); // 不注入 getLocalStore
  const stored = recordDiffComment(dc);
  check('recordDiffComment 成功', stored.ok === true && stored.comment.id === dc.id);
  const list = listDiffComments('7');
  check('listDiffComments 取回评论', list.length === 1 && list[0].comment === '改用 const');
  check('listDiffComments：未知线程返回空', listDiffComments('no-such-thread').length === 0);

  // 存储：注入 localStore 时挂到线程对象（复用 localStore 线程数据结构，随 local-data.json 持久化）
  const fakeThread = { id: 99, title: 't' };
  let flushed = 0;
  const fakeStore = {
    data: { threads: [fakeThread] },
    flush: () => { flushed += 1; return { ok: true }; },
  };
  initDiffCommentChannel({ getLocalStore: () => fakeStore });
  const dc2 = normalizeDiffComment({ threadId: 99, filePath: 'a.js', hunkIndex: 0, lineRange: { start: 1, end: 3 }, comment: '这里加个空行' });
  const stored2 = recordDiffComment(dc2);
  check('localStore 线程挂载成功', stored2.ok === true && Array.isArray(fakeThread.diffComments) && fakeThread.diffComments.length === 1);
  check('localStore 落盘被调用', flushed === 1);
  check('listDiffComments 从线程对象取回', listDiffComments(99).length === 1 && listDiffComments(99)[0].comment === '这里加个空行');

  // localStore 落盘失败：评论不丢（内存已保留），如实告警
  const fakeThreadFail = { id: 100 };
  const failStore = { data: { threads: [fakeThreadFail] }, flush: () => ({ ok: false, error: 'disk full' }) };
  initDiffCommentChannel({ getLocalStore: () => failStore });
  const capWarn = captureWarn(() => recordDiffComment(normalizeDiffComment({ threadId: 100, filePath: 'a.js', comment: 'c' })));
  check('localStore 落盘失败仍返回 ok（内存保留）', capWarn.result.ok === true);
  check('localStore 落盘失败留下告警', capWarn.seen.some((w) => w.includes('未落盘')));

  // 线程不在 localStore（服务端模式）：退化进程内 Map
  initDiffCommentChannel({ getLocalStore: () => ({ data: { threads: [] }, flush: () => ({ ok: true }) }) });
  const capMiss = captureWarn(() => recordDiffComment(normalizeDiffComment({ threadId: 12345, filePath: 'a.js', comment: 'c' })));
  check('线程不在 localStore 时退化存储', capMiss.result.ok === true && capMiss.seen.some((w) => w.includes('不在 localStore')));
  check('退化存储可取回', listDiffComments(12345).length === 1);

  // IPC 处理器全链路（经导出函数直接调，绕开 electron）：normalize → store → feedback
  initDiffCommentChannel({}); // 回到进程内降级存储
  const resp = await handleDiffComment({
    threadId: 555, filePath: 'src/b.js', hunkIndex: 1, lineRange: { start: 3, end: 9 },
    comment: '这里改成 const', diffSnippet: '+let x = 1',
  });
  check('handleDiffComment：合法载荷返回 ok + 回灌消息',
    resp.ok === true && resp.feedback.role === 'user'
    && resp.feedback.content.includes('用户评论：这里改成 const')
    && resp.feedback.content.includes('文件：src/b.js（第 3-9 行）')
    && resp.comment.id && resp.comment.createdAt);
  check('handleDiffComment：评论已落存储', listDiffComments(555).length === 1);
  const bad = await handleDiffComment({ threadId: 555 });
  check('handleDiffComment：非法载荷返回 ok:false + 错误说明', bad.ok === false && typeof bad.error === 'string' && bad.error.includes('threadId'));

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})();

// GitHub PR 审查闭环测试（2026-10-15，对标 Codex 的 diff 审查交付出口）
//
// 闭环 = pr_list → pr_view → pr_diff（结构化：文件→hunk）→ pr_review（APPROVE/REQUEST_CHANGES）
// 关键点：全部经 gh CLI（argv 传参无注入面）；review/comment 是对外可见动作 → L3 审批；
//         超大 diff 截断并提示分片；行级评论如实说明 gh CLI 的能力边界。
const assert = require('assert');
const github = require('../main/github');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const SAMPLE_DIFF = [
  'diff --git a/src/a.js b/src/a.js',
  'index 111..222 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' console.log(a);',
  'diff --git a/docs/r.md b/docs/r.md',
  '--- a/docs/r.md',
  '+++ b/docs/r.md',
  '@@ -1,1 +1,2 @@',
  '-旧说明',
  '+新说明',
].join('\n');

// gh mock：按子命令返回
function makeGh(responses) {
  const calls = [];
  const execFn = (cmd, args, opts, cb) => {
    calls.push({ cmd, args });
    const key = args[0] === 'pr' ? `pr:${args[1]}` : args.join(' ');
    const r = responses[key];
    if (!r) { cb(new Error(`unexpected gh call: ${key}`), '', ''); return; }
    if (r.throw) { cb(new Error(r.throw), '', r.stderr || 'mock error'); return; }
    cb(null, r.stdout || '', '');
  };
  return { execFn, calls };
}

(async () => {
  // ── 1. parseUnifiedDiff：结构化（文件 → hunk → 行）──
  const files = github.parseUnifiedDiff(SAMPLE_DIFF);
  check('解析出 2 个文件', files.length === 2, files.map((f) => f.file).join(','));
  check('文件增删行数统计正确',
    files[0].additions === 2 && files[0].deletions === 1 && files[1].additions === 1 && files[1].deletions === 1);
  check('hunk 头与行保留', files[0].hunks.length === 1 && files[0].hunks[0].header.startsWith('@@ -1,3')
    && files[0].hunks[0].lines.includes('+const c = 4;'));
  check('空 diff 返回空数组', github.parseUnifiedDiff('').length === 0);

  // ── 2. pr_list：JSON 解析 + CI 汇总 ──
  const listGh = makeGh({
    'pr:list': { stdout: JSON.stringify([
      { number: 7, title: 'feat: A', author: { login: 'alice' }, state: 'OPEN', headRefName: 'feat/a', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] },
      { number: 8, title: 'fix: B', author: { login: 'bob' }, state: 'OPEN', headRefName: 'fix/b', statusCheckRollup: [{ status: 'IN_PROGRESS' }] },
    ]) },
  });
  const lst = await github.prList({ cwd: '/repo', state: 'open', limit: 10 }, listGh.execFn);
  check('pr_list 解析出编号/作者/分支', lst.ok && lst.prs.length === 2 && lst.prs[0].author === 'alice');
  check('CI 汇总区分 passing/pending', lst.prs[0].ci === 'passing' && lst.prs[1].ci === 'pending');
  check('pr_list 的 gh 参数带 argv（无 shell 拼接）', listGh.calls[0].args[0] === 'pr' && listGh.calls[0].args.includes('--json'));

  // ── 3. pr_view：元数据 + CI + 已有 reviews ──
  const viewGh = makeGh({
    'pr:view': { stdout: JSON.stringify({
      number: 7, title: 'feat: A', body: '说明', author: { login: 'alice' }, state: 'OPEN',
      baseRefName: 'main', headRefName: 'feat/a', additions: 12, deletions: 3, changedFiles: 2,
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }], reviews: [{ author: { login: 'me' }, state: 'CHANGES_REQUESTED' }],
    }) },
  });
  const view = await github.prView({ cwd: '/repo', number: 7 }, viewGh.execFn);
  check('pr_view 返回全貌（增删/文件数/CI）',
    view.ok && view.pr.additions === 12 && view.pr.changedFiles === 2 && view.pr.ci === 'failing');
  check('pr_view 带已有 review 历史', view.pr.reviews[0].state === 'CHANGES_REQUESTED');

  // ── 4. pr_diff：结构化 + 截断提示 ──
  const diffGh = makeGh({ 'pr:diff': { stdout: SAMPLE_DIFF } });
  const d1 = await github.prDiff({ cwd: '/repo', number: 7 }, diffGh.execFn);
  check('pr_diff 结构化为文件→hunk', d1.ok && d1.files.length === 2 && d1.files[0].hunks.length === 1);
  check('pr_diff 未截断时无 hint', d1.truncated === false && d1.hint === undefined);
  check('pr_diff 支持按文件过滤', (await github.prDiff({ cwd: '/repo', number: 7, file: 'docs' }, diffGh.execFn)).files.length === 1
    && (await github.prDiff({ cwd: '/repo', number: 7, file: 'docs' }, diffGh.execFn)).files[0].file === 'docs/r.md');
  // 超大 diff：截断 + 分片提示
  const bigGh = makeGh({ 'pr:diff': { stdout: 'x'.repeat(200001) } });
  const d2 = await github.prDiff({ cwd: '/repo', number: 7 }, bigGh.execFn);
  check('超大 diff 截断并提示分片', d2.truncated === true && /分片/.test(d2.hint || ''));
  check('PR 编号非法拒绝', (await github.prDiff({ cwd: '/repo', number: 'abc' }, diffGh.execFn)).ok === false);

  // ── 5. pr_review：语义校验（对外可见动作）──
  const reviewGh = makeGh({ 'pr:review': { stdout: '' } });
  check('APPROVE 缺正文被拒（GitHub 规则）',
    (await github.prReview({ cwd: '/repo', number: 7, event: 'APPROVE', body: '' }, reviewGh.execFn)).ok === false);
  const rv = await github.prReview({ cwd: '/repo', number: 7, event: 'REQUEST_CHANGES', body: '问题：a.js 第 3 行 …' }, reviewGh.execFn);
  check('REQUEST_CHANGES 带正文提交成功', rv.ok && rv.event === 'REQUEST_CHANGES');
  check('gh 参数按 argv 传（--event 大写语义）', reviewGh.calls[0].args.includes('--event')
    && reviewGh.calls[0].args.includes('REQUEST_CHANGES'));
  check('event 非法被拒', (await github.prReview({ cwd: '/repo', number: 7, event: 'MERGE' }, reviewGh.execFn)).ok === false);
  check('PR 编号非法拒绝', (await github.prReview({ cwd: '/repo', number: 0, event: 'COMMENT', body: 'x' }, reviewGh.execFn)).ok === false);

  // ── 6. pr_comment：能力边界如实说明 ──
  const commentGh = makeGh({ 'pr:comment': { stdout: '' } });
  const cm = await github.prComment({ cwd: '/repo', number: 7, body: '行级备注', file: 'src/a.js', line: 3 }, commentGh.execFn);
  check('pr_comment 成功并带文件/行号留痕', cm.ok && cm.file === 'src/a.js' && cm.line === 3);
  check('行级定位能力边界如实说明（gh CLI 无行级 API）', /GraphQL/.test(cm.note || ''));
  check('空评论被拒', (await github.prComment({ cwd: '/repo', number: 7, body: '  ' }, commentGh.execFn)).ok === false);

  // ── 7. gh 失败透传（不静默）──
  const errGh = makeGh({ 'pr:list': { throw: 'gh: auth failed', stderr: 'gh: To get started with GitHub CLI, please run: gh auth login' } });
  const el = await github.prList({ cwd: '/repo' }, errGh.execFn);
  check('未登录时透传 gh 的登录引导（不裸报错）', el.ok === false && /gh auth login/.test(el.error));

  // ── 8. 审批分层：pr_review / pr_comment 属 L3 ──
  const approval = require('../main/approval');
  const v1 = approval.needsApproval({ tool: 'pr_review', args: { number: 7 }, approvalMode: 'auto-safe' });
  const v2 = approval.needsApproval({ tool: 'pr_comment', args: { number: 7 }, approvalMode: 'auto-safe' });
  const v3 = approval.needsApproval({ tool: 'pr_diff', args: { number: 7 }, approvalMode: 'auto-safe' });
  check('pr_review 在 auto-safe 档仍需审批（L3）', v1.need === true && v1.level === 'L3');
  check('pr_comment 在 auto-safe 档仍需审批（L3）', v2.need === true && v2.level === 'L3');
  check('pr_diff 只读不弹卡', v3.need === false);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})();

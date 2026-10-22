// DS Bots / T6-6 测试：工件协同四工具（artifact_index / get_section / patch_section / get_diff）
//
// 验收判据（设计稿 §15 T6-6）：
//   ① 4 个原生工具返回体不超闸（索引 ≤1.2k tokens、读取 ≤8000 字符、diff ≤4000 字符）；
//   ② 正文不进消息——patch 回执只给 {version, chars}，团队总线只写 artifact_ref 摘要 + 引用。
// 另覆盖 §14 越权防护：项目身份只能来自宿主上下文，模型传 project_id 仅做一致性校验。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const { ProjectStore } = require('../main/projectStore');
const { ArtifactStore, LIMITS } = require('../main/artifactStore');
const { createArtifactToolHandlers, fitIndex, INDEX_CHAR_BUDGET } = require('../main/artifactTools');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-artifact-tools-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const projects = new ProjectStore(db);
  const store = new ArtifactStore(db);
  projects.createProject({ projectId: 'prj_a', name: 'A 项目', objective: '写一份 PRD' });
  projects.createProject({ projectId: 'prj_b', name: 'B 项目', objective: '另一个项目' });

  const art = store.createArtifact({
    artifactId: 'art_1', projectId: 'prj_a', title: '需求文档',
    outline: [
      { key: 'goal', title: '目标', order: 0 },
      { key: 'scope', title: '范围', order: 1 },
      { key: 'risk', title: '风险', order: 2 },
    ],
  });
  // 另一个项目的工件（越权用例）
  store.createArtifact({
    artifactId: 'art_b', projectId: 'prj_b', title: 'B 文档', outline: [{ key: 'x', title: 'X', order: 0 }],
  });

  const ctx = { projectId: 'prj_a', artifactId: 'art_1' };
  const make = (over = {}) => createArtifactToolHandlers({
    artifactContext: ctx, getArtifactStore: () => store, ...over,
  });

  // ── ① 项目身份：只能来自宿主上下文 ──
  {
    const h = createArtifactToolHandlers({ artifactContext: null, getArtifactStore: () => store });
    check('无项目上下文 → NO_PROJECT_CONTEXT（不抛异常）',
      h.artifactIndex().code === 'NO_PROJECT_CONTEXT');
    check('无项目上下文时 patch 也被拒', (await h.artifactPatchSection({ section_key: 'goal', base_version: 'V0.0', content: 'x' })).code === 'NO_PROJECT_CONTEXT');
  }
  check('模型传 project_id 与宿主不一致 → PROJECT_FORBIDDEN',
    make().artifactIndex({ project_id: 'prj_b' }).code === 'PROJECT_FORBIDDEN');
  check('模型指定他项目工件 → PROJECT_FORBIDDEN（按归属校验，不是按传参）',
    make().artifactGetSection({ artifactId: 'art_b', section_key: 'x' }).code === 'PROJECT_FORBIDDEN');
  check('存储不可用 → STORE_UNAVAILABLE',
    createArtifactToolHandlers({ artifactContext: ctx, getArtifactStore: () => null }).artifactIndex().code === 'STORE_UNAVAILABLE');

  // ── ② artifact_index：只给结构元信息，不含正文 ──
  {
    const ix = make().artifactIndex({});
    check('索引成功且带当前版本', ix.ok === true && ix.currentVersion === 'V0.0' && ix.artifactId === 'art_1');
    check('索引含全部章节（key/title/chars/version）',
      ix.outline.length === 3 && ix.outline.map((s) => s.key).join(',') === 'goal,scope,risk'
      && ix.outline.every((s) => typeof s.chars === 'number' && typeof s.version === 'string'));
    check('索引不含任何正文（无 content 字段）', ix.outline.every((s) => !('content' in s)) && !('content' in ix));
  }

  // ── ③ 索引体积预算：逐级降级，不截半个 JSON ──
  {
    const big = {
      artifactId: 'a', currentVersion: 'V1.00', sizeBytes: 1,
      outline: Array.from({ length: 80 }, (_, i) => ({
        key: `sec_${i}`, title: `这是一个相当长的章节标题用于撑爆预算 ${i}`, level: 1,
        version: 'V0.05', chars: 4000, updatedBy: 'm1', updatedAt: 1,
      })),
      recentChanges: Array.from({ length: 5 }, (_, i) => ({
        sectionKey: 'sec_0', version: `V0.0${i}`, changeSummary: '变更说明'.repeat(20), authorMemberId: 'm1', createdAt: 1,
      })),
    };
    const fitted = fitIndex(big);
    check('超预算索引被裁剪到 ≤ 预算', JSON.stringify(fitted).length <= INDEX_CHAR_BUDGET + 200,
      `${JSON.stringify(fitted).length} 字符 / 预算 ${INDEX_CHAR_BUDGET}`);
    check('裁剪后仍是可解析结构且标注 truncated', fitted.truncated === true && Array.isArray(fitted.outline) && !!fitted.note);
    check('被砍掉的章节数有交代（outlineTotal）', fitted.outlineTotal === 80 && fitted.outline.length < 80);
    const small = fitIndex({ artifactId: 'a', outline: [], recentChanges: [] });
    check('未超预算不做任何裁剪', small.truncated === false && !small.note);
  }

  // ── ④ artifact_get_section：片段读取 + 字符闸 ──
  {
    const content = `起点${'内容'.repeat(6000)}终点`; // 12003 字符 > 单次 8000 上限
    const p = await make({ approvalDeps: { approvalMode: 'auto-safe' } })
      .artifactPatchSection({ section_key: 'goal', base_version: 'V0.0', content, change_summary: '写长文' });
    check('长文写入成功', p.ok === true, p.error || '');
    const r = make().artifactGetSection({ section_key: 'goal' });
    check('单次读取被字符闸截断', r.ok === true && r.content.length === LIMITS.readChars && r.truncated === true && r.chars === content.length);
    const r2 = make().artifactGetSection({ section_key: 'goal', offset: r.nextOffset, maxChars: 100000 });
    check('offset 翻页可读到尾部', r2.ok === true && r2.content.endsWith('终点') && r2.truncated === false);
    check('未知章节 → SECTION_NOT_FOUND 且给出可选键',
      (() => { const x = make().artifactGetSection({ section_key: 'nope' });
        return x.code === 'SECTION_NOT_FOUND' && Array.isArray(x.available) && x.available.includes('goal'); })());
  }

  // ── ⑤ artifact_patch_section：乐观锁 + 回执不含正文 ──
  {
    const before = store.getArtifact('art_1').currentVersion;
    const noBase = await make().artifactPatchSection({ section_key: 'goal', content: '无条件覆盖' });
    check('缺 base_version → BASE_VERSION_REQUIRED', noBase.code === 'BASE_VERSION_REQUIRED');
    check('缺 base_version 时不落库', store.getArtifact('art_1').currentVersion === before);

    const conflict = await make({ approvalDeps: { approvalMode: 'auto-safe' } })
      .artifactPatchSection({ section_key: 'goal', base_version: 'V0.0', content: '基于旧版本' });
    check('base 过期 → VERSION_CONFLICT 且附当前版本与 diff',
      conflict.code === 'VERSION_CONFLICT' && conflict.currentVersion === before && typeof conflict.diff === 'string');

    const ok = await make({ approvalDeps: { approvalMode: 'auto-safe' } })
      .artifactPatchSection({ section_key: 'scope', base_version: before, content: '范围：只做 M1', change_summary: '补范围' });
    check('写入成功返回新版本与字数', ok.ok === true && ok.version === 'V0.02' && ok.chars === 8, JSON.stringify(ok));
    check('回执不含正文（正文不进消息链）', !('content' in ok) && !('content' in (ok.section || {})));
    check('回执只保留 key/title 结构', ok.section && ok.section.key === 'scope' && ok.section.title === '范围');

    const tooLong = await make({ approvalDeps: { approvalMode: 'auto-safe' } })
      .artifactPatchSection({ section_key: 'scope', base_version: ok.version, content: 'x'.repeat(LIMITS.patchChars + 1) });
    check('单次 patch 超 16000 字符 → PATCH_TOO_LARGE', tooLong.code === 'PATCH_TOO_LARGE');
  }

  // ── ⑥ 审批闸：L2 写入按档位，宿主绑定值优先于模型参数 ──
  {
    const cur = store.getArtifact('art_1').currentVersion;
    const calls = [];
    const onRequest = make({
      approvalDeps: {
        approvalMode: 'on-request',
        requestApproval: async (tool, args) => { calls.push({ tool, key: args.section_key }); return 'allow'; },
        applyApprovalDecision: () => {},
      },
    });
    const r = await onRequest.artifactPatchSection({ section_key: 'risk', base_version: cur, content: '风险：待补' });
    check('on-request 档写入会请求审批', calls.length === 1 && calls[0].tool === 'artifact_patch_section' && r.ok === true);

    const cur2 = store.getArtifact('art_1').currentVersion;
    const denyCalls = [];
    const denied = await make({
      approvalDeps: { approvalMode: 'on-request', requestApproval: async () => { denyCalls.push(1); return 'deny'; } },
    }).artifactPatchSection({ section_key: 'risk', base_version: cur2, content: '不应落库' });
    check('用户拒绝 → denied 且不写库', denied.denied === true && denyCalls.length === 1
      && store.getArtifact('art_1').currentVersion === cur2);

    let autoCalls = 0;
    const autoSafe = await make({
      approvalDeps: { approvalMode: 'auto-safe', requestApproval: async () => { autoCalls++; return 'deny'; } },
    }).artifactPatchSection({ section_key: 'risk', base_version: cur2, content: '自动放行' });
    check('auto-safe 档 L2 写入自动放行（不弹审批）', autoCalls === 0 && autoSafe.ok === true);

    const cur3 = store.getArtifact('art_1').currentVersion;
    const hostBound = [];
    const spoofed = await make({
      approvalDeps: { approvalMode: 'on-request', requestApproval: async () => { hostBound.push(1); return 'deny'; } },
    }).artifactPatchSection({ section_key: 'risk', base_version: cur3, content: '模型谎报档位', approvalMode: 'auto-safe' });
    check('模型传 approvalMode=auto-safe 不能绕过宿主绑定档位',
      hostBound.length === 1 && spoofed.denied === true && store.getArtifact('art_1').currentVersion === cur3);

    check('无审批通道时 fail-closed（APPROVAL_UNAVAILABLE）',
      (await make({ approvalDeps: { approvalMode: 'on-request' } })
        .artifactPatchSection({ section_key: 'risk', base_version: cur3, content: 'x' })).code === 'APPROVAL_UNAVAILABLE');
  }

  // ── ⑦ artifact_ref：只在成员任务（有团队总线）写，且只写摘要 + 引用 ──
  {
    const sent = [];
    const teamCtx = { projectId: 'prj_a', artifactId: 'art_1', teamId: 't1', runId: 'g1', memberId: 'm1' };
    const cur = store.getArtifact('art_1').currentVersion;
    const h = createArtifactToolHandlers({
      artifactContext: teamCtx, getArtifactStore: () => store,
      postMessage: (msg) => sent.push(msg),
      approvalDeps: { approvalMode: 'auto-safe' },
    });
    const r = await h.artifactPatchSection({
      section_key: 'goal', base_version: cur, content: '团队写入的目标', change_summary: '对齐目标',
    });
    check('团队通道写入成功', r.ok === true);
    check('成功写一条 artifact_ref（宿主写入，非模型自觉）',
      sent.length === 1 && sent[0].kind === 'artifact_ref' && sent[0].teamId === 't1'
      && sent[0].runId === 'g1' && sent[0].fromMemberId === 'm1');
    check('引用串含工件/章节/版本', Array.isArray(sent[0].refs)
      && sent[0].refs[0] === `artifact:art_1#goal@${r.version}`);
    check('总线消息不含正文（只有摘要 + 载荷元信息）',
      !JSON.stringify(sent[0]).includes('团队写入的目标')
      && sent[0].payload.chars === r.chars && sent[0].payload.version === r.version);

    const sent2 = [];
    const cur2 = store.getArtifact('art_1').currentVersion;
    const h2 = createArtifactToolHandlers({
      artifactContext: ctx, getArtifactStore: () => store,
      postMessage: (msg) => sent2.push(msg), approvalDeps: { approvalMode: 'auto-safe' },
    });
    await h2.artifactPatchSection({ section_key: 'goal', base_version: cur2, content: '交互式写入' });
    check('交互式会话（无团队上下文）不写总线', sent2.length === 0);
  }

  // ── ⑧ artifact_get_diff：版本差异，字符闸 ──
  {
    const cur = store.getArtifact('art_1').currentVersion;
    await make({ approvalDeps: { approvalMode: 'auto-safe' } })
      .artifactPatchSection({ section_key: 'goal', base_version: cur, content: '改过的目标' });
    const d = make().artifactGetDiff({ from_version: cur, to_version: store.getArtifact('art_1').currentVersion, section_key: 'goal' });
    check('diff 返回成功且含变化行', d.ok === true && typeof d.diff === 'string' && d.diff.includes('+ 改过的目标'),
      (d.diff || '').slice(0, 40));
    check('diff 体积不超闸', d.diff.length <= LIMITS.diffChars);
    check('非法版本 → INVALID_VERSION', make().artifactGetDiff({ from_version: 'bad', to_version: 'V0.0' }).code === 'INVALID_VERSION');
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} artifact-tools：${pass} 通过 / ${fail} 失败`);
  try { db.close && db.close(); } catch { /* 关闭失败不影响结果 */ }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('❌ 测试异常终止:', e);
  process.exit(1);
});

// DS Bots / T6-5 测试：工件仓储（版本重建 / 乐观锁 409 / 体积闸 / 归档 / diff）
//
// 验收判据（设计稿 §15 T6-5）：
//   ① `Vn` 片段读取正确 —— 按「version ≤ Vn 的最新历史行」重建，不存全文副本；
//   ② 冲突返回 409 语义 —— base_version ≠ current_version 抛 VERSION_CONFLICT，并带可自我修正的 diff。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDbAsync } = require('../main/db');
const { ProjectStore } = require('../main/projectStore');
const {
  ArtifactStore, ArtifactError, LIMITS, versionValue, nextVersion, lineDiff,
} = require('../main/artifactStore');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const codeOf = (fn) => {
  try { fn(); return 'NO_THROW'; } catch (e) { return e instanceof ArtifactError ? e.code : `RAW:${e && e.message}`; }
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-artifact-'));
  const db = await openDbAsync(dir, { driver: 'sqljs' });
  const projects = new ProjectStore(db);
  const store = new ArtifactStore(db);

  projects.createProject({ projectId: 'prj_a', name: 'A 项目', objective: '写一份 PRD' });

  // ── 版本号工具：两位序号、进位、非法值 ──
  check('versionValue V0.0=0 / V0.12=12 / V1.0=100',
    versionValue('V0.0') === 0 && versionValue('V0.12') === 12 && versionValue('V1.0') === 100);
  check('versionValue 非法返回 -1', versionValue('0.1') === -1 && versionValue('V0') === -1);
  check('nextVersion V0.0 → V0.01', nextVersion('V0.0') === 'V0.01');
  check('nextVersion 两位序号递增 V0.09 → V0.10', nextVersion('V0.09') === 'V0.10');
  check('nextVersion 进位 V0.99 → V1.00（minor 归零，保持两位）', nextVersion('V0.99') === 'V1.00');
  check('nextVersion 非法入参抛 INVALID_VERSION', codeOf(() => nextVersion('x')) === 'INVALID_VERSION');

  // ── 创建：V0.0 + 章节预建 + __outline__ ──
  const art = store.createArtifact({
    artifactId: 'art_1',
    projectId: 'prj_a',
    title: '需求文档',
    outline: [
      { key: 'goal', title: '目标', order: 0 },
      { key: 'scope', title: '范围', order: 1 },
      { key: 'risk', title: '风险', order: 2 },
    ],
  });
  check('创建返回 V0.0 与大纲', art.currentVersion === 'V0.0' && art.outline.length === 3 && art.kind === 'document');
  check('大纲按 order 排序', art.outline.map((s) => s.key).join(',') === 'goal,scope,risk');
  check('章节行已预建（可区分「章节不存在」与「还没写过」）',
    db.prepare('SELECT COUNT(*) AS c FROM artifact_sections WHERE artifact_id = ?').get('art_1').c === 4);
  check('__outline__ 存大纲 JSON 快照',
    JSON.parse(db.prepare("SELECT content FROM artifact_sections WHERE artifact_id='art_1' AND section_key='__outline__'").get().content).length === 3);
  check('非项目拒绝创建', codeOf(() => store.createArtifact({ projectId: 'prj_x', title: 't', outline: [{ key: 'a' }] })) === 'PROJECT_NOT_FOUND');
  check('标题必填', codeOf(() => store.createArtifact({ projectId: 'prj_a', title: '', outline: [{ key: 'a' }] })) === 'TITLE_REQUIRED');
  check('空大纲拒绝', codeOf(() => store.createArtifact({ projectId: 'prj_a', title: 't', outline: [] })) === 'OUTLINE_REQUIRED');
  check('重复章节键拒绝', codeOf(() => store.createArtifact({ projectId: 'prj_a', title: 't', outline: [{ key: 'a' }, { key: 'a' }] })) === 'DUPLICATE_SECTION');
  check('保留键 __outline__ 不得占用', codeOf(() => store.createArtifact({ projectId: 'prj_a', title: 't', outline: [{ key: '__outline__' }] })) === 'INVALID_SECTION_KEY');
  check('章节数超 50 拒绝',
    codeOf(() => store.createArtifact({ projectId: 'prj_a', title: 't', outline: Array.from({ length: 51 }, (_, i) => ({ key: `s${i}` })) })) === 'OUTLINE_TOO_LARGE');
  check('非法 kind 拒绝', codeOf(() => store.createArtifact({ projectId: 'prj_a', title: 't', kind: 'x', outline: [{ key: 'a' }] })) === 'INVALID_KIND');

  // ── 写入：版本递增 + 回执只给短信息（正文不进消息链） ──
  const p1 = store.patchSection({
    artifactId: 'art_1', sectionKey: 'goal', content: '第一版目标', baseVersion: 'V0.0', changeSummary: '初稿',
  });
  check('首次写入 V0.0 → V0.01', p1.version === 'V0.01' && p1.chars === 5);
  check('回执不含正文（§9.3 正文永不进消息链）', !('content' in p1) && p1.section.key === 'goal');
  check('元信息版本与体积同步', store.getArtifact('art_1').currentVersion === 'V0.01' && store.getArtifact('art_1').sizeBytes > 0);

  const p2 = store.patchSection({
    artifactId: 'art_1', sectionKey: 'scope', content: '范围：MVP', baseVersion: 'V0.01',
  });
  check('第二次写入 V0.01 → V0.02', p2.version === 'V0.02');
  check('历史只记变更章节（增量快照）',
    db.prepare('SELECT COUNT(*) AS c FROM artifact_section_versions WHERE artifact_id = ?').get('art_1').c === 2);

  // ── 乐观锁：base_version 必须等于当前版本 ──
  let conflict = null;
  try {
    store.patchSection({ artifactId: 'art_1', sectionKey: 'goal', content: '基于旧版本的覆盖', baseVersion: 'V0.01' });
  } catch (e) { conflict = e; }
  check('基于旧版本写入抛 VERSION_CONFLICT（409 语义）', conflict && conflict.code === 'VERSION_CONFLICT');
  check('冲突附带当前版本 + 你的 base + 短 diff',
    conflict && conflict.details.currentVersion === 'V0.02'
    && conflict.details.yourBaseVersion === 'V0.01' && /第一版目标/.test(conflict.details.diff));
  check('冲突不落任何写入（事务外校验）',
    store.getArtifact('art_1').currentVersion === 'V0.02'
    && store.getSection({ artifactId: 'art_1', sectionKey: 'goal' }).content === '第一版目标');
  check('缺 base_version 抛 BASE_VERSION_REQUIRED',
    codeOf(() => store.patchSection({ artifactId: 'art_1', sectionKey: 'goal', content: 'x' })) === 'BASE_VERSION_REQUIRED');
  check('章节不在大纲内抛 SECTION_NOT_FOUND',
    codeOf(() => store.patchSection({ artifactId: 'art_1', sectionKey: 'nope', content: 'x', baseVersion: 'V0.02' })) === 'SECTION_NOT_FOUND');

  // ── 体积闸：patch 字符 / 单章节字节 / 全工件字节 ──
  check('patch 超 16000 字符抛 PATCH_TOO_LARGE',
    codeOf(() => store.patchSection({
      artifactId: 'art_1', sectionKey: 'risk', content: 'x'.repeat(LIMITS.patchChars + 1), baseVersion: 'V0.02',
    })) === 'PATCH_TOO_LARGE');
  // 单章节字节闸是「patch 字符闸」的冗余后备：16000 字符 × 4 字节（UTF-8 单字符上限）
  // = 64000 < 65536，故在当前 patch 上限下永不先触发；保留它只为日后放宽 patchChars 时兜底。
  check('单章节字节闸为后备（patch 字符上限已更紧）', LIMITS.patchChars * 4 <= LIMITS.sectionBytes);

  // 全工件 2MB 闸：多章节累加才会触达（单次 patch 永远到不了）
  store.createArtifact({
    artifactId: 'art_big', projectId: 'prj_a', title: '大工件',
    outline: Array.from({ length: 50 }, (_, i) => ({ key: `s${i}`, title: `章 ${i}` })),
  });
  let bigVer = 'V0.0';
  let bigCode = 'NO_THROW';
  for (let i = 0; i < 50; i += 1) {
    try {
      // 每章 16000 个中文字符 = 48000 字节；44 章即越过 2MB
      bigVer = store.patchSection({
        artifactId: 'art_big', sectionKey: `s${i}`, content: '中'.repeat(16000), baseVersion: bigVer,
      }).version;
    } catch (e) { bigCode = e.code; break; }
  }
  check('全工件超 2MB 抛 ARTIFACT_TOO_LARGE 且已写章节不受影响',
    bigCode === 'ARTIFACT_TOO_LARGE' && store.getSection({ artifactId: 'art_big', sectionKey: 's0' }).chars === 16000,
    `code=${bigCode}`);

  // ── 历史版本读取：V0.01 读到旧内容，V0.02 读到新值 ──
  store.patchSection({ artifactId: 'art_1', sectionKey: 'goal', content: '第二版目标', baseVersion: 'V0.02' });
  const cur = store.getSection({ artifactId: 'art_1', sectionKey: 'goal' });
  const atOld = store.getSection({ artifactId: 'art_1', sectionKey: 'goal', version: 'V0.01' });
  const atNow = store.getSection({ artifactId: 'art_1', sectionKey: 'goal', version: 'V0.03' });
  check('当前读取 = 最新正文', cur.content === '第二版目标' && cur.version === 'V0.03');
  check('V0.01 读取命中历史行（version ≤ Vn 的最新一行）', atOld.content === '第一版目标' && atOld.version === 'V0.01');
  check('V0.03 读取 = 最新值', atNow.content === '第二版目标');
  check('未写过的章节读空串（V0.0）', store.getSection({ artifactId: 'art_1', sectionKey: 'risk', version: 'V0.0' }).content === '');
  check('非法版本号抛 INVALID_VERSION',
    codeOf(() => store.getSection({ artifactId: 'art_1', sectionKey: 'goal', version: 'v1' })) === 'INVALID_VERSION');
  check('不存在的章节抛 SECTION_NOT_FOUND 并列出可用键',
    (() => {
      try { store.getSection({ artifactId: 'art_1', sectionKey: 'ghost' }); return false; } catch (e) {
        return e.code === 'SECTION_NOT_FOUND' && Array.isArray(e.details.available) && e.details.available.includes('goal');
      }
    })());

  // ── 分段读取：offset / maxChars / truncated / nextOffset（按字符而非字节）──
  const long = '甲'.repeat(100);
  store.createArtifact({ artifactId: 'art_2', projectId: 'prj_a', title: '长文', outline: [{ key: 'body', title: '正文' }] });
  store.patchSection({ artifactId: 'art_2', sectionKey: 'body', content: long, baseVersion: 'V0.0' });
  const part1 = store.getSection({ artifactId: 'art_2', sectionKey: 'body', offset: 0, maxChars: 30 });
  const part2 = store.getSection({ artifactId: 'art_2', sectionKey: 'body', offset: part1.nextOffset, maxChars: 30 });
  const tail = store.getSection({ artifactId: 'art_2', sectionKey: 'body', offset: 90, maxChars: 30 });
  check('分段读取首段 30 字符 + truncated + nextOffset=30',
    part1.content.length === 30 && part1.truncated && part1.nextOffset === 30 && part1.chars === 100);
  check('第二段从 30 继续', part2.content === '甲'.repeat(30) && part2.nextOffset === 60);
  check('末段 truncated=false / nextOffset=null', tail.content === '甲'.repeat(10) && !tail.truncated && tail.nextOffset === null);
  check('maxChars 被硬上限收敛（不得越权读全量）',
    store.getSection({ artifactId: 'art_2', sectionKey: 'body', maxChars: 999999 }).content.length === 100);

  // ── 版本重建：Vn → 全章节映射 ──
  const r1 = store.rebuildVersion({ artifactId: 'art_1', version: 'V0.01' });
  const r3 = store.rebuildVersion({ artifactId: 'art_1', version: 'V0.03' });
  check('V0.01 重建：goal 为旧值、scope 为空',
    r1.sections.goal.content === '第一版目标' && r1.sections.scope.content === '' && r1.sections.risk.content === '');
  check('V0.03 重建：goal 为新值、scope 保留 V0.02 写入',
    r3.sections.goal.content === '第二版目标' && r3.sections.scope.content === '范围：MVP');
  check('重建返回总字符数', r3.chars === 11, `chars=${r3.chars}`);

  // ── diff：单章节 + 全工件 ──
  const dSec = store.getDiff({ artifactId: 'art_1', fromVersion: 'V0.01', toVersion: 'V0.03', sectionKey: 'goal' });
  const dAll = store.getDiff({ artifactId: 'art_1', fromVersion: 'V0.01', toVersion: 'V0.03' });
  check('单章节 diff 含删/增行', /- 第一版目标/.test(dSec.diff) && /\+ 第二版目标/.test(dSec.diff));
  // 相同前缀行被折叠成「@@ N 行相同 @@」，这是 diff 裁剪的预期行为（不是丢内容）
  check('全工件 diff 折叠相同前缀 + 含新增章节行',
    /@@ 1 行相同 @@/.test(dAll.diff) && /\+ 范围：MVP/.test(dAll.diff));
  check('diff 非法版本抛 INVALID_VERSION',
    codeOf(() => store.getDiff({ artifactId: 'art_1', fromVersion: 'x', toVersion: 'V0.03' })) === 'INVALID_VERSION');
  check('diff 未知名章节抛 SECTION_NOT_FOUND',
    codeOf(() => store.getDiff({ artifactId: 'art_1', fromVersion: 'V0.01', toVersion: 'V0.03', sectionKey: 'zzz' })) === 'SECTION_NOT_FOUND');
  check('lineDiff 截断标注', lineDiff('a', 'b', { maxChars: 2 }).includes('diff 已截断'));

  // ── 保留策略：超 retain 只归档不删除（历史仍可读、可恢复）──
  store.createArtifact({ artifactId: 'art_3', projectId: 'prj_a', title: '保留', outline: [{ key: 'x' }], retainVersions: 2 });
  let ver = 'V0.0';
  for (let i = 1; i <= 5; i += 1) {
    ver = store.patchSection({ artifactId: 'art_3', sectionKey: 'x', content: `第 ${i} 版`, baseVersion: ver }).version;
  }
  const arch = db.prepare('SELECT COUNT(*) AS total, SUM(archived) AS arch FROM artifact_section_versions WHERE artifact_id = ?').get('art_3');
  check('保留最近 2 条，其余置 archived=1（不删除）', arch.arch === 3 && arch.total === 5);
  check('归档行仍可显式按版本读取（可恢复）',
    store.getSection({ artifactId: 'art_3', sectionKey: 'x', version: 'V0.01' }).content === '第 1 版');
  check('非项目拒绝读取', codeOf(() => store.getSection({ artifactId: 'art_missing', sectionKey: 'x' })) === 'NOT_FOUND');

  // 同一毫秒创建时 created_at 相同，顺序不保证——按集合断言，避免时钟粒度导致假红
  const listed = store.listArtifacts('prj_a').map((a) => a.artifactId).sort().join(',');
  check('listArtifacts 返回本项目全部 4 个工件', listed === 'art_1,art_2,art_3,art_big');

  // ── T6-10 侧面板「版本快照列表」：只给元信息，正文由 section 通道按需分页读 ──
  const vers = store.listVersions({ artifactId: 'art_1' });
  check('listVersions 按版本倒序（新→旧）',
    vers.versions.map((v) => v.version).join(',') === 'V0.03,V0.02,V0.01',
    vers.versions.map((v) => v.version).join(','));
  check('listVersions 回填当前版本与标题',
    vers.currentVersion === 'V0.03' && vers.title === '需求文档' && vers.artifactId === 'art_1');
  check('listVersions 按版本聚合章节键',
    vers.versions.find((v) => v.version === 'V0.02').sectionKeys.join(',') === 'scope');
  check('listVersions 汇总变更说明',
    vers.versions.find((v) => v.version === 'V0.01').changeSummary === '初稿');
  check('listVersions 不含正文（面板只读索引，正文走 artifacts:section）',
    vers.versions.every((v) => !('content' in v) && !('sections' in v)));
  check('listVersions limit 生效', store.listVersions({ artifactId: 'art_1', limit: 1 }).versions.length === 1);
  store.createArtifact({ artifactId: 'art_empty', projectId: 'prj_a', title: '空', outline: [{ key: 'x' }] });
  check('listVersions 无历史返回空数组',
    store.listVersions({ artifactId: 'art_empty' }).versions.length === 0);
  check('listVersions 未知工件抛 NOT_FOUND',
    codeOf(() => store.listVersions({ artifactId: 'art_missing' })) === 'NOT_FOUND');

  db.close();
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 存在失败'}：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常终止：', e);
  process.exit(1);
});

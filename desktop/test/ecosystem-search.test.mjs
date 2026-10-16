// 生态中心搜索匹配单测（lib/ecosystemSearch.ts 纯函数）
// 覆盖：分词 / 逐词 AND / 大小写与子串（中文模糊）/ 字段覆盖广度 / 空查询不过滤 /
//      嵌套字段（env_vars、permissions）可被搜到 —— 最后一条正是本次用户反馈的根因。
// 运行：node test/ecosystem-search.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.join(import.meta.dirname, '..');
const MOD = pathToFileURL(path.join(ROOT, 'renderer', 'src', 'lib', 'ecosystemSearch.ts')).href;
const { searchTokens, haystack, matchesTokens, entryMatches, connectorFields, skillFields, employeeFields } = await import(MOD);

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass += 1; }
  catch (e) { console.error(`❌ ${name} — ${e.message}`); fail += 1; }
}

// ── 分词 ──
check('分词：按空白切分并小写化', () => {
  assert.deepEqual(searchTokens('  Software   MCP '), ['software', 'mcp']);
});
check('分词：空输入返回空数组（组件据此跳过过滤）', () => {
  assert.deepEqual(searchTokens(''), []);
  assert.deepEqual(searchTokens('   '), []);
  assert.deepEqual(searchTokens(null), []);
  assert.deepEqual(searchTokens(undefined), []);
});

// ── 逐词 AND ──
check('空 tokens 恒真（不过滤，列表全量显示）', () => {
  assert.equal(matchesTokens(['anything'], []), true);
});
check('单词子串命中（大小写不敏感，输入经 searchTokens 归一）', () => {
  assert.equal(matchesTokens(['GitHub 集成'], searchTokens('github')), true);
  assert.equal(matchesTokens(['github'], searchTokens('HUB')), true);
  assert.equal(matchesTokens(['GitHub 集成'], searchTokens('集成')), true);
});
check('matchesTokens 约定：tokens 必须是 searchTokens 的产物（原样大写不匹配，属预期）', () => {
  // 记录这条边界：本函数不做二次归一化，避免每个条目都重复 lower 造成无谓开销。
  assert.equal(matchesTokens(['github'], ['HUB']), false);
  assert.equal(matchesTokens(['github'], searchTokens('HUB')), true);
});
check('多词为 AND：全部命中才通过', () => {
  const fields = ['知识库搜索', '腾讯 ima'];
  assert.equal(matchesTokens(fields, ['知识库', '腾讯']), true);
  assert.equal(matchesTokens(fields, ['知识库', '不存在词']), false);
});
check('中文模糊：词是字段的子串即命中', () => {
  assert.equal(matchesTokens(['软件开发与交付'], ['软件']), true);
});

// ── 干草堆展开 ──
check('haystack 摊平嵌套数组与对象值', () => {
  const hay = haystack(['a', ['b', { nested: 'c' }], { name: 'd', meta: { deep: 'e' } }, null, undefined, '']);
  for (const v of ['a', 'b', 'c', 'd', 'e']) assert.ok(hay.includes(v), `缺少 ${v}`);
  assert.equal(hay.length, 5, `应剔除空值，实际=${hay.length}`);
});

// ── 连接器：本次 bug 的根因字段 ──
const CONNECTOR = {
  id: 'mcp-ima', name: 'ima-mcp', display_name: '腾讯 ima 知识库 MCP', vendor: 'Tencent',
  category: '知识库与笔记', transport: 'stdio', auth_type: 'api_key', auth_mode: 'paste_key',
  maturity: 'community',
  description: '接入腾讯 ima 知识库：搜索、读取与写入个人/共享知识库笔记。',
  capabilities: ['知识库搜索', '读取笔记', '写入笔记'],
  permissions: [{ level: 'network', scope: 'ima.qq.com' }],
  env_vars: [{ name: 'IMA_CLIENT_ID', label: 'ima Client ID' }, { name: 'IMA_API_KEY', label: 'ima API Key' }],
};

check('连接器：description 中的词可被搜到（旧实现此处恒为空）', () => {
  assert.equal(entryMatches('connector', CONNECTOR, searchTokens('笔记')), true);
  assert.equal(entryMatches('connector', CONNECTOR, searchTokens('写入')), true);
});
check('连接器：capabilities 中的词可被搜到', () => {
  assert.equal(entryMatches('connector', CONNECTOR, searchTokens('知识库搜索')), true);
});
check('连接器：env_vars 的名称与标签可被搜到', () => {
  assert.equal(entryMatches('connector', CONNECTOR, searchTokens('IMA_API_KEY')), true);
  assert.equal(entryMatches('connector', CONNECTOR, searchTokens('client id')), true);
});
check('连接器：permissions 的 scope 可被搜到', () => {
  assert.equal(entryMatches('connector', CONNECTOR, searchTokens('ima.qq.com')), true);
});
check('连接器：display_name / vendor 等原有字段不回归', () => {
  assert.equal(entryMatches('connector', CONNECTOR, searchTokens('ima')), true);
  assert.equal(entryMatches('connector', CONNECTOR, searchTokens('tencent')), true);
});
check('连接器：无关词不命中（避免假阳性）', () => {
  assert.equal(entryMatches('connector', CONNECTOR, searchTokens('向量数据库')), false);
});
check('连接器：多词组合命中（腾讯 + 笔记）', () => {
  assert.equal(entryMatches('connector', CONNECTOR, searchTokens('腾讯 笔记')), true);
});

// ── 技能 / 数字员工 ──
const SKILL = { id: 'gen-docs', name: 'gen-docs', display_name: '文档生成', category: '文档', description: '生成 README 与接口文档', tools_required: ['read_file', 'write_file'] };
check('技能：description 与 tools_required 可被搜到', () => {
  assert.equal(entryMatches('skill', SKILL, searchTokens('readme')), true);
  assert.equal(entryMatches('skill', SKILL, searchTokens('write_file')), true);
  assert.equal(entryMatches('skill', SKILL, searchTokens('接口')), true);
});
check('技能：无关词不命中', () => {
  assert.equal(entryMatches('skill', SKILL, searchTokens('数据库迁移')), false);
});

const EMPLOYEE = { name: 'architect', title_cn: '系统架构师', category: '研发', industry: ['互联网'], summary: '负责系统设计与技术选型' };
check('数字员工：title_cn / industry / summary 可被搜到', () => {
  assert.equal(entryMatches('employee', EMPLOYEE, searchTokens('架构师')), true);
  assert.equal(entryMatches('employee', EMPLOYEE, searchTokens('互联网')), true);
  assert.equal(entryMatches('employee', EMPLOYEE, searchTokens('技术选型')), true);
});

// ── 字段清单可测（防止有人悄悄缩窄范围） ──
check('三类条目的字段清单覆盖关键可读字段', () => {
  assert.ok(connectorFields(CONNECTOR).includes(CONNECTOR.description));
  assert.ok(connectorFields(CONNECTOR).includes(CONNECTOR.capabilities));
  assert.ok(skillFields(SKILL).includes(SKILL.description));
  assert.ok(employeeFields(EMPLOYEE).includes(EMPLOYEE.summary));
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);

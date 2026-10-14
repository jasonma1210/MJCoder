// skillCompat 测试：SKILL.md 双向转换 + 安装防护 + 外部仓库导入 + 生态目录安装
const fs = require('fs');
const path = require('path');
const os = require('os');
const compat = require('../main/skillCompat');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── 导入：SKILL.md → 条目（含 Claude 兼容键）──
const claudeSkill = [
  '---',
  'name: code-reviewer',
  'description: Reviews code changes',
  'allowed-tools: Read, Grep, Bash',
  'license: MIT',
  '---',
  '',
  '# Review workflow',
  '1. read diff',
  '2. report issues',
].join('\n');
const e1 = compat.skillMdToEntry('code-reviewer', claudeSkill);
check('Claude frontmatter 解析 name', e1.name === 'code-reviewer');
check('allowed-tools 映射 tools_required', e1.tools_required.join(',') === 'Read,Grep,Bash', e1.tools_required.join(','));
check('license 透传', e1.license === 'MIT');
check('正文剥离 frontmatter', e1.content.startsWith('# Review workflow'));
check('未知来源标记 source=skill-md', e1.source === 'skill-md');

// ── 导出：条目 → SKILL.md → 再导入（round-trip）──
const entry = {
  id: 'code-review', name: 'code-review', display_name: '代码审查',
  description: '对代码变更做结构化审查',
  category: '代码评审与重构', tags: ['评审', '缺陷发现'],
  tools_required: ['read', 'grep', 'bash'],
  approval_policy: 'on-request',
  content: '## 角色\n你是资深代码评审者。',
  workflow: ['获取变更范围', '先跑构建与测试'],
  permissions: [{ level: 'filesystem', scope: 'workspace' }],
};
const md = compat.entryToSkillMd(entry);
check('导出含标准 name/description', md.includes('name: code-review') && md.includes('description: 对代码变更做结构化审查'));
check('导出含 allowed-tools 扩展', md.includes('allowed-tools: read,grep,bash'));
check('workflow 附加到正文', md.includes('## 工作流') && md.includes('1. 获取变更范围'));
const roundTrip = compat.skillMdToEntry('code-review', md);
check('round-trip name 保持', roundTrip.name === 'code-review');
check('round-trip description 保持', roundTrip.description === '对代码变更做结构化审查');
check('round-trip tools 保持', roundTrip.tools_required.join(',') === 'read,grep,bash');

// ── 安装：路径防护 + 原子写入 ──
const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-compat-'));
const inst = compat.installSkillToDir(skillsDir, entry);
check('安装成功并返回目录名', inst.ok && inst.dir === 'code-review');
check('SKILL.md 落盘', fs.existsSync(path.join(skillsDir, 'code-review', 'SKILL.md')));
check('无临时文件残留', !fs.existsSync(path.join(skillsDir, 'code-review', 'SKILL.md.tmp')));

check('拒绝路径穿越', compat.installSkillToDir(skillsDir, { name: '../evil', id: '../evil' }).ok === false);
check('拒绝点目录', compat.installSkillToDir(skillsDir, { name: '.', id: '.' }).ok === false);
check('缺少 name 拒绝', compat.installSkillToDir(skillsDir, {}).ok === false);

// ── 外部仓库导入（Claude 布局：skills/<name>/SKILL.md，嵌套两层）──
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-skillrepo-'));
fs.mkdirSync(path.join(repo, 'skills', 'reviewer'), { recursive: true });
fs.writeFileSync(path.join(repo, 'skills', 'reviewer', 'SKILL.md'), claudeSkill);
fs.mkdirSync(path.join(repo, 'node_modules', 'fake'), { recursive: true });
fs.writeFileSync(path.join(repo, 'node_modules', 'fake', 'SKILL.md'), '---\nname: fake\n---\nx');
fs.mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true });
fs.writeFileSync(path.join(repo, '.git', 'hooks', 'SKILL.md'), '---\nname: gitfake\n---\nx');
const scan = compat.importSkillsFromDir(repo);
check('扫描发现 1 个技能（跳过 node_modules/.git）', scan.ok && scan.skills.length === 1, `found=${scan.skills.length}`);
check('导入条目可安装', compat.installSkillToDir(skillsDir, scan.skills[0]).ok === true);
check('目录不存在报错', compat.importSkillsFromDir('/tmp/mjcode-no-such-repo').ok === false);

// ── 生态目录安装（skills.json 私有格式 → SKILL.md）──
const eco = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-eco-'));
fs.writeFileSync(path.join(eco, 'skills.json'), JSON.stringify([
  { id: 'gen-docs', name: 'gen-docs', display_name: '文档生成', description: '生成 README', content: '生成文档内容', tools_required: ['read'] },
]));
const catInst = compat.installCatalogSkill([eco], skillsDir, 'gen-docs');
check('生态技能安装成功', catInst.ok && catInst.dir === 'gen-docs');
const installedMd = fs.readFileSync(path.join(skillsDir, 'gen-docs', 'SKILL.md'), 'utf8');
check('安装产物是标准 SKILL.md', installedMd.startsWith('---\nname: gen-docs'));
check('skills.json 未在候选时明确报错', compat.installCatalogSkill([skillsDir], skillsDir, 'gen-docs').ok === false);
check('未知 id 明确报错', compat.installCatalogSkill([eco], skillsDir, 'no-such').ok === false);

fs.rmSync(skillsDir, { recursive: true, force: true });
fs.rmSync(repo, { recursive: true, force: true });
fs.rmSync(eco, { recursive: true, force: true });

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);

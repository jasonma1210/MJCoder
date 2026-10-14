// SKILL.md 解析与发现测试
const fs = require('fs');
const path = require('path');
const os = require('os');
const skills = require('../main/skills');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// frontmatter 解析
const meta = skills.parseFrontmatter('---\nname: code-review\ndescription: "审查代码质量，找出问题"\n---\n# 正文\n内容');
check('解析 name/description', meta.name === 'code-review' && meta.description === '审查代码质量，找出问题');
check('无 frontmatter 回落空值', skills.parseFrontmatter('# 没有头').name === '');
check('引号包裹值被剥离', skills.parseFrontmatter('---\nname: "x"\n---').name === 'x');

// 目录发现
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-skills-'));
fs.mkdirSync(path.join(dir, 'review'), { recursive: true });
fs.writeFileSync(path.join(dir, 'review', 'SKILL.md'), '---\nname: review\ndescription: 代码审查技能\n---\n1. 检查 bug');
fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
fs.writeFileSync(path.join(dir, 'docs', 'SKILL.md'), '---\nname: docs\ndescription: 文档生成\n---\n生成 README');
fs.mkdirSync(path.join(dir, 'empty'), { recursive: true }); // 无 SKILL.md，应被忽略
fs.writeFileSync(path.join(dir, 'stray.txt'), 'not a skill');

const list = skills.listSkills(dir);
check('发现 2 个技能（忽略无 SKILL.md 目录与散文件）', list.length === 2, list.map((s) => s.name).join(','));
check('按名称排序', list[0].name === 'docs' && list[1].name === 'review');
check('getSkill 返回完整内容', String(skills.getSkill(dir, 'review')).includes('检查 bug'));
check('getSkill 不存在回落 null', skills.getSkill(dir, 'ghost') === null);
check('目录不存在回落空数组', skills.listSkills('/tmp/mjcode-no-such-dir').length === 0);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);

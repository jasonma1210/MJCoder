// SKILL.md 技能体系：~/.mjcode/skills/<name>/SKILL.md
// 纯函数部分（解析）不依赖 electron，便于单测；目录由调用方注入
const fs = require('fs');
const path = require('path');

// 解析 YAML frontmatter（--- 包裹的 name/description 等键值对）
function parseFrontmatter(content) {
  const m = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { name: '', description: '' };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (key) meta[key] = value;
    }
  }
  return meta;
}

// 列出技能目录下全部技能（读取各子目录 SKILL.md 的 frontmatter）
function listSkills(skillsDir) {
  if (!fs.existsSync(skillsDir)) return [];
  const skills = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    try {
      const content = fs.readFileSync(file, 'utf8');
      const meta = parseFrontmatter(content);
      skills.push({
        name: meta.name || entry.name,
        dir: entry.name,
        description: meta.description || '',
      });
    } catch (e) {
      console.warn(`[skills] 读取失败: ${file}`, e.message);
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// 读取单个技能完整内容
function getSkill(skillsDir, name) {
  const file = path.join(skillsDir, name, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

module.exports = { parseFrontmatter, listSkills, getSkill };

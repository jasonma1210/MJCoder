// SKILL.md 技能体系：~/.mjcode/skills/<name>/SKILL.md
// 纯函数部分（解析）不依赖 electron，便于单测；目录由调用方注入
const fs = require('fs');
const path = require('path');
// N9：技能按需加载命中率观测（requested/loaded/missed）——纯内存计数器，无 electron 依赖。
const { governanceStats } = require('./governanceStats');

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

// 按技能名批量读取内容（数字员工 starter_skills 的运行时挂载用）：
// listSkills 给出 name→dir 映射（frontmatter 的 name 可能与目录名不同），两者都参与查找；
// 未找到的名称静默跳过（fail-open：缺一个技能不阻塞整个员工的会话）。
function loadSkillContents(skillsDir, names) {
  const wanted = (Array.isArray(names) ? names : [names]).map(String).map((s) => s.trim()).filter(Boolean);
  if (!wanted.length) return [];
  const byKey = new Map();
  for (const s of listSkills(skillsDir)) {
    byKey.set(s.name, s.dir);
    if (!byKey.has(s.dir)) byKey.set(s.dir, s.dir);
  }
  const out = [];
  for (const n of wanted) {
    const dir = byKey.get(n);
    const content = dir ? getSkill(skillsDir, dir) : null;
    if (content) out.push({ name: n, content });
  }
  // N9：按需加载命中率——requested 是「声称要挂载的技能数」，loaded 是「真读到内容的数」，
  // 二者之差即 missed（配了却没生效：名不对/目录缺失）。缺 skill 本身 fail-open 跳过，但要让观测看得见。
  governanceStats.incr('skills', 'requested', wanted.length);
  governanceStats.incr('skills', 'loaded', out.length);
  governanceStats.incr('skills', 'missed', wanted.length - out.length);
  return out;
}

module.exports = { parseFrontmatter, listSkills, getSkill, loadSkillContents };

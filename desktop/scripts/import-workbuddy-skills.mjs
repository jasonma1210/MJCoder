#!/usr/bin/env node
// WorkBuddy 本地专家包技能 → MJCode 技能库 + 数字员工挂载（一次性导入，幂等可复跑）
//
// 做三件事：
//   1) 扫描 ~/.workbuddy/plugins/marketplaces/experts/plugins/<pkg>/skills/<skill>/SKILL.md，
//      经 skillCompat（SKILL.md 标准互通层）安装到 ~/.mjcode/skills/<name>/（overwrite:false，
//      与本地已有技能重名时跳过，绝不覆盖用户现有技能）；
//   2) 把新装技能登记进 ecosystem/skills.json 目录（产品内技能市场可见；id 冲突跳过）；
//   3) 按「专家包 → 数字员工」映射表，把技能 id 追加进对应员工的 starter_skills
//      （只追加不删除；每员工 starter_skills 总量上限 12，防止 system prompt 膨胀失控）。
//
// 运行时链路（导入后即生效）：生态中心「用此角色开会话」→ rolePreset.skillNames
//   → agentRunner 按名装载 SKILL.md → 引擎按不可信内容管道注入 system prompt。
//
// 用法：node scripts/import-workbuddy-skills.mjs [--dry-run]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const skillCompat = require('../main/skillCompat.js');
const { slug: slugify } = require('../main/ecosystem.js');

const DRY_RUN = process.argv.includes('--dry-run');
const SRC_ROOT = process.env.WBB_EXPERTS_DIR
  || path.join(os.homedir(), '.workbuddy', 'plugins', 'marketplaces', 'experts', 'plugins');
const SKILLS_DIR = path.join(os.homedir(), '.mjcode', 'skills');
const ECOSYSTEM_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?!\/)/, '/')), '..', '..', 'ecosystem');
const MAX_STARTER_SKILLS = 12; // 每员工 starter_skills 上限：技能内容经引擎 guardUntrusted 截 6000 字/条，防 prompt 膨胀

// ── 专家包 → 数字员工映射（保守：只在职能语义明确对应时挂载；拿不准的不挂）──
const EXPERT_TO_EMPLOYEES = {
  // 工程技术
  'frontend-developer': ['de-frontend-engineer'],
  'frontend-backend-experts': ['de-frontend-engineer', 'de-software-engineer'],
  'modern-webapp': ['de-frontend-engineer'],
  'we-chat-mini-program-developer': ['de-frontend-engineer'],
  'design-to-code': ['de-frontend-engineer'],
  'senior-developer': ['de-software-engineer'],
  'software-architect': ['de-software-engineer'],
  'software-company': ['de-software-engineer', 'de-project-manager'],
  'fullstack-architects': ['de-software-engineer'],
  'fullstack-dev': ['de-software-engineer'],
  'fullstack-forge-team': ['de-software-engineer'],
  'ai-engineer': ['de-ai-research-engineer'],
  'aicoding-architecture-expert-team': ['de-software-engineer'],
  'agent-harness-architect': ['de-software-engineer'],
  'agent-orchestrator': ['de-software-engineer'],
  'enterprise-agent-architect': ['de-software-engineer'],
  'mvp-dev-expert-team': ['de-software-engineer'],
  'godot-game-script-engineer': ['de-software-engineer'],
  'test-results-analyst': ['de-qa-engineer'],
  // 设计
  'ui-designer': ['de-ux-designer'],
  'ui-ux-design': ['de-ux-designer'],
  'user-experience-architect': ['de-ux-designer'],
  'design-engine': ['de-ux-designer'],
  'design-md-architect': ['de-ux-designer'],
  // 产品
  'product-management': ['de-product-manager'],
  'product-strategy-team': ['de-product-manager'],
  // 内容 / 教育
  'content-creator': ['de-technical-writer'],
  'long-manuscript-expert': ['de-technical-writer'],
  'courseweaver': ['de-learning-designer', 'de-instructional-designer'],
  'k12-education': ['de-learning-designer', 'de-tutoring-assistant'],
  'k12-courseware-designer': ['de-instructional-designer'],
  // 营销 / 运营
  'xiaohongshu-operations-expert': ['de-social-media-operator'],
  'wechat-official-account-expert': ['de-social-media-operator', 'de-seo-content-marketer'],
  'zero-cost-monetization-mentor': ['de-growth-marketer'],
  'cross-border-ecommerce-expert': ['de-growth-marketer'],
  // 数据
  'ai-data-copilot': ['de-data-analyst'],
  'data-analytics-reporter': ['de-data-analyst'],
  // 金融
  'equity-research': ['de-quant-research-analyst', 'de-financial-advisor'],
  'investment-masters-team': ['de-quant-research-analyst'],
  'tdx-stock-diagnostician': ['de-quant-research-analyst'],
  'trading-agent': ['de-quant-research-analyst'],
  // 法务 / 税务
  'chatlaw-team': ['de-legal-counsel'],
  'tax-compliance-team': ['de-tax-specialist'],
  // 研究 / 媒体
  'gpt-researcher-team': ['de-ai-research-engineer'],
  'video-gen-team': ['de-motion-designer'],
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// ── 1. 安装技能（skillCompat 标准互通层；overwrite:false = 幂等且不覆盖本地已有）──
const report = { dryRun: DRY_RUN, packages: [], installed: [], skippedExisting: [], catalogAdded: [], employeesUpdated: [] };
const pkgDirs = fs.existsSync(SRC_ROOT)
  ? fs.readdirSync(SRC_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];
if (!pkgDirs.length) {
  console.error(`[import] 未找到专家包目录：${SRC_ROOT}`);
  process.exit(1);
}

const catalogPath = path.join(ECOSYSTEM_DIR, 'skills.json');
const catalog = readJson(catalogPath, []);
const catalogList = Array.isArray(catalog) ? catalog : (catalog.skills || []);
const catalogIds = new Set(catalogList.map((s) => s.id));

const employeesPath = path.join(ECOSYSTEM_DIR, 'digital-employees.json');
const employees = readJson(employeesPath, []);
const byId = new Map((Array.isArray(employees) ? employees : []).map((e) => [e.id, e]));

for (const pkg of pkgDirs) {
  const pkgSkillsDir = path.join(SRC_ROOT, pkg, 'skills');
  if (!fs.existsSync(pkgSkillsDir)) continue;
  const scan = skillCompat.importSkillsFromDir(pkgSkillsDir);
  if (!scan.ok || !scan.skills?.length) {
    report.packages.push({ pkg, found: 0 });
    continue;
  }
  report.packages.push({ pkg, found: scan.skills.length });
  const mappedEmployees = EXPERT_TO_EMPLOYEES[pkg] || [];
  for (const entry of scan.skills) {
    // 1a. 安装到 ~/.mjcode/skills（重名跳过 = 保留用户现有技能）
    const inst = DRY_RUN
      ? { ok: !fs.existsSync(path.join(SKILLS_DIR, slugify(entry.id), 'SKILL.md')), dir: entry.id }
      : skillCompat.installSkillToDir(SKILLS_DIR, entry, { overwrite: false });
    if (inst.ok) report.installed.push({ pkg, id: entry.id, name: entry.name });
    else report.skippedExisting.push({ pkg, id: entry.id, reason: inst.error });

    // 1b. 目录登记（id 已在目录中则跳过；登记不含 content，保持目录轻量）
    if (!catalogIds.has(entry.id) && inst.ok) {
      catalogList.push({
        id: entry.id,
        name: entry.name,
        display_name: entry.display_name || entry.name,
        category: '专家技能',
        tags: [pkg],
        description: entry.description || '',
        tools_required: entry.tools_required || [],
        permissions: [],
        approval_policy: entry.approval_policy || 'on-request',
        source: 'workbuddy-expert',
        expert_package: pkg,
      });
      catalogIds.add(entry.id);
      report.catalogAdded.push(entry.id);
    }

    // 1c. 挂载到映射的数字员工（starter_skills 只追加、去重、总量封顶）
    for (const deId of mappedEmployees) {
      const emp = byId.get(deId);
      if (!emp) continue;
      const cur = Array.isArray(emp.starter_skills) ? emp.starter_skills : [];
      if (cur.includes(entry.id)) continue;
      if (cur.length >= MAX_STARTER_SKILLS) {
        report.employeesUpdated.push({ employee: deId, skill: entry.id, result: 'skipped-cap' });
        continue;
      }
      emp.starter_skills = [...cur, entry.id];
      report.employeesUpdated.push({ employee: deId, skill: entry.id, result: 'appended' });
    }
  }
}

// ── 2. 落盘（dry-run 只出报告）──
if (!DRY_RUN) {
  fs.writeFileSync(catalogPath, JSON.stringify(catalogList, null, 2) + '\n', 'utf8');
  fs.writeFileSync(employeesPath, JSON.stringify(employees, null, 2) + '\n', 'utf8');
}

// ── 3. 员工 starter_skills 缺口补装（目录有元数据但本地无 SKILL.md 实例的，按目录物化补装）──
// 这是 WorkBuddy 导入之外的历史缺口：原 starter_skills 引用了 skills.json 里的 id，
// 但本地从未安装——运行时 loadSkillContents 按名找不到，技能等于没挂。installCatalogSkill 幂等。
const gapFilled = [];
const gapFailed = [];
for (const emp of (Array.isArray(employees) ? employees : [])) {
  for (const sid of (emp.starter_skills || []).map(String)) {
    if (fs.existsSync(path.join(SKILLS_DIR, slugify(sid), 'SKILL.md'))) continue;
    if (DRY_RUN) { gapFilled.push({ employee: emp.id, skill: sid, result: 'dry-run' }); continue; }
    const r = skillCompat.installCatalogSkill([ECOSYSTEM_DIR], SKILLS_DIR, sid);
    (r.ok ? gapFilled : gapFailed).push({ employee: emp.id, skill: sid, ...(r.ok ? {} : { error: r.error }) });
  }
}

// ── 4. 落盘报告 ──
if (!DRY_RUN) {
  fs.writeFileSync(path.join(ECOSYSTEM_DIR, 'workbuddy-import-report.json'),
    JSON.stringify({ ...report, gapFilled, gapFailed }, null, 2) + '\n', 'utf8');
}

// ── 3. 摘要 ──
const capSkipped = report.employeesUpdated.filter((u) => u.result === 'skipped-cap').length;
console.log(`[import] 专家包 ${report.packages.length} 个 · 技能发现 ${report.packages.reduce((s, p) => s + p.found, 0)} 个`);
console.log(`[import] 新装技能 ${report.installed.length} · 本地已存在跳过 ${report.skippedExisting.length}`);
console.log(`[import] 目录登记新增 ${report.catalogAdded.length} · 员工挂载追加 ${report.employeesUpdated.filter((u) => u.result === 'appended').length}（上限跳过 ${capSkipped}）`);
console.log(`[import] 员工技能缺口补装 ${gapFilled.filter((g) => g.result !== 'dry-run').length}${DRY_RUN ? `（dry-run 探得缺口 ${gapFilled.length}）` : ''}${gapFailed.length ? ` · 失败 ${gapFailed.length}` : ''}`);
if (DRY_RUN) console.log('[import] dry-run：未写任何文件');
else console.log(`[import] 报告已写入 ${path.join(ECOSYSTEM_DIR, 'workbuddy-import-report.json')}`);

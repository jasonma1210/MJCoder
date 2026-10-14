// 生态资产目录加载器（M7）：把 50 数字员工 / 100 MCP 连接器 / 100 Skill 接入产品
// 纯数据层：读取 ecosystem/*.json 并做归一化与关联，不依赖 electron，便于单测
const fs = require('fs');
const path = require('path');

// 产品审批矩阵实际支持的模式（与 main/approval.js 对齐）；非法值一律降级为最保守的 on-request
const VALID_APPROVAL = ['on-request', 'auto-safe', 'always', 'safe-auto', 'trusted'];
// 沙箱策略（与 main/sandbox.js 对齐）
const VALID_SANDBOX = ['read-only', 'workspace-write', 'full-access'];
// 模型档位
const VALID_TIER = ['fast', 'standard', 'reasoning'];

function normalizeApproval(v) {
  return VALID_APPROVAL.includes(v) ? v : 'on-request';
}
function normalizeSandbox(v) {
  return VALID_SANDBOX.includes(v) ? v : 'workspace-write';
}
function normalizeTier(v) {
  return VALID_TIER.includes(v) ? v : 'standard';
}

// ── 数字员工（Digital Employees）──
function loadDigitalEmployees(ecosystemDir) {
  const file = path.join(ecosystemDir, 'digital-employees.json');
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : (data.employees || data.items || []);
    return list.map((e) => ({
      ...e,
      id: e.id || slug(e.name || e.title_cn || ''),
      // 归一化：非法策略值降级为最保守默认（fail-closed），避免生态数据绕过审批矩阵
      approval_policy: normalizeApproval(e.approval_policy),
      sandbox_policy: normalizeSandbox(e.sandbox_policy),
      default_model_tier: normalizeTier(e.default_model_tier),
      industry: Array.isArray(e.industry) ? e.industry : [e.industry || '通用'],
      tools: Array.isArray(e.tools) ? e.tools : [],
      core_skills: Array.isArray(e.core_skills) ? e.core_skills : [],
      starter_skills: Array.isArray(e.starter_skills) ? e.starter_skills : [],
    }));
  } catch (err) {
    console.error('[ecosystem] 数字员工加载失败:', err.message);
    return [];
  }
}

// ── MCP 连接器 ──
function loadMcpConnectors(ecosystemDir) {
  const file = path.join(ecosystemDir, 'mcp-connectors.json');
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : (data.connectors || data.items || []);
    return list.map((c) => ({
      ...c,
      id: c.id || slug(c.name || ''),
      official: !!c.official,
      // 权限归一化：只保留白名单级别，缺失默认 filesystem(workspace) 的最小集由安装器处理
      permissions: (Array.isArray(c.permissions) ? c.permissions : []).filter(
        (p) => p && ['filesystem', 'network', 'shell'].includes(p.level)
      ),
      env_vars: Array.isArray(c.env_vars) ? c.env_vars : [],
      capabilities: Array.isArray(c.capabilities) ? c.capabilities : [],
      maturity: c.maturity || 'community',
    }));
  } catch (err) {
    console.error('[ecosystem] MCP 连接器加载失败:', err.message);
    return [];
  }
}

// ── Skill 索引（落盘的 SKILL.md 由 skills.js 负责加载；这里读 JSON 元数据做产品内展示/关联）──
function loadSkillCatalog(ecosystemDir) {
  const file = path.join(ecosystemDir, 'skills.json');
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : (data.skills || data.items || []);
    return list.map((s) => ({
      id: s.id || slug(s.name || ''),
      name: s.name,
      display_name: s.display_name || s.name,
      category: s.category || '通用',
      tags: Array.isArray(s.tags) ? s.tags : [],
      description: s.description || '',
      tools_required: Array.isArray(s.tools_required) ? s.tools_required : [],
      permissions: Array.isArray(s.permissions) ? s.permissions : [],
      approval_policy: normalizeApproval(s.approval_policy),
    }));
  } catch (err) {
    console.error('[ecosystem] Skill 目录加载失败:', err.message);
    return [];
  }
}

// slug 规范化（kebab-case）
function slug(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// 汇总目录
function loadEcosystem(ecosystemDir) {
  const employees = loadDigitalEmployees(ecosystemDir);
  const connectors = loadMcpConnectors(ecosystemDir);
  const skills = loadSkillCatalog(ecosystemDir);
  return {
    employees,
    connectors,
    skills,
    stats: {
      employees: employees.length,
      connectors: connectors.length,
      skills: skills.length,
      employeeCategories: [...new Set(employees.map((e) => e.category).filter(Boolean))],
      connectorCategories: [...new Set(connectors.map((c) => c.category).filter(Boolean))],
      skillCategories: [...new Set(skills.map((s) => s.category).filter(Boolean))],
    },
  };
}

// 按职业大类分组数字员工
function groupEmployeesByCategory(employees) {
  const out = {};
  for (const e of employees) {
    const k = e.category || '通用';
    (out[k] = out[k] || []).push(e);
  }
  return out;
}

// 按分类分组 MCP 连接器
function groupConnectorsByCategory(connectors) {
  const out = {};
  for (const c of connectors) {
    const k = c.category || '其他';
    (out[k] = out[k] || []).push(c);
  }
  return out;
}

module.exports = {
  loadEcosystem,
  loadDigitalEmployees,
  loadMcpConnectors,
  loadSkillCatalog,
  groupEmployeesByCategory,
  groupConnectorsByCategory,
  slug,
};
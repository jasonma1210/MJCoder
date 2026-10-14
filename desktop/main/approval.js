// 审批中心：分级判定 + 规则匹配（纯函数部分，可单测）
// 档位：on-request（默认，写操作询问）/ auto-safe（L2 自动，L1/L3 询问）/ always（全部询问）/ never（全不询问）
// 规则：{ tool, pattern, scope: 'always' } —— 「始终允许」持久化于 userData/approval-rules.json
//      { tool, pattern, scope: 'conversation', conversationId } —— 「本对话同类」主进程内存

const LEVELS = { L1: 'danger-command', L2: 'file-write', L3: 'mcp-tool' };

// 工具 → 默认分级
const TOOL_LEVEL = {
  shell: 'L1', // 命中危险模式才实际询问（见 needsApproval）
  git_commit: 'L2', git_add: 'L2', apply_patch: 'L2',
  write_file: 'L2', edit_file: 'L2',
  mcp__: 'L3',
  // 对话内插件安装 = 给模型「装软件」的能力（网络下载 + 落盘 + 注册服务），
  // 恒为 L3：任何审批档位都弹卡确认，且不可经「本对话同类」规则静默放行
  install_plugin: 'L3',
};

// 只读工具：任何档位都不询问
const READONLY_TOOLS = new Set([
  'read_file', 'list_dir', 'grep', 'glob',
  'git_status', 'git_diff', 'git_log', 'git_branch',
]);

// P0-S1：危险命令规则不再在本文件手写副本，统一从 dangerousPatterns.js 导入。
// 事故背景：本文件原有一份 10 条的 DANGEROUS_PATTERNS，注释声称「与主进程保持同步」，
// 但主进程 sandbox.js 实际是 12 条且已漂移 —— 漂移导致审批层比沙箱层**更宽松**，
// 于是 `curl xxx | sh` / `rm --recursive --force` 这类命令能同时绕过两层守卫，
// 在默认 on-request 档下不弹任何审批直接执行。现改为单一事实来源，从根上消除漂移可能。
const { DANGEROUS_PATTERNS, isDangerousCommand } = require('./dangerousPatterns');

function toolLevel(tool, args = {}) {
  if (READONLY_TOOLS.has(tool)) return null;
  if (tool === 'shell') {
    return DANGEROUS_PATTERNS.some((p) => p.test(String(args.command || ''))) ? 'L1' : null;
  }
  if (tool.startsWith('mcp__')) return 'L3';
  return TOOL_LEVEL[tool] || 'L2';
}

// 综合判定：该次工具调用是否需要弹审批
function needsApproval({ tool, args = {}, approvalMode = 'on-request', conversationId, alwaysRules = [], conversationRules = [] }) {
  if (approvalMode === 'never') return { need: false };
  const level = toolLevel(tool, args);
  if (!level) return { need: false };

  // 规则豁免（始终允许 / 本对话同类）
  // P1-C：L1 危险命令不接受任何规则豁免——「始终允许」也不可覆盖危险命令，fail-closed。
  // 原实现下 pattern='*' 或宽松正则可让 rm -rf / 之类永久放行，是审批中心最大的缺口。
  if (level !== 'L1') {
    const target = approvalTarget(tool, args);
    if (alwaysRules.some((r) => r.tool === tool && matchPattern(r.pattern, target))) {
      return { need: false, matched: 'always' };
    }
    if (conversationRules.some((r) => r.tool === tool && r.conversationId === conversationId && matchPattern(r.pattern, target))) {
      return { need: false, matched: 'conversation' };
    }
  }

  if (approvalMode === 'always') return { need: true, level };
  if (approvalMode === 'auto-safe' && level === 'L2') return { need: false };
  return { need: true, level };
}

// 规则匹配对象：shell 取 command，文件类取 path，mcp 取 server/tool
function approvalTarget(tool, args = {}) {
  if (tool === 'shell') return String(args.command || '');
  if (tool === 'install_plugin') return String(args.url || args.pkg || args.name || '');
  if (tool.startsWith('mcp__')) return tool;
  return String(args.path || args.patch?.slice(0, 80) || args.message || '');
}

// P1-C：规则匹配改「前缀白名单」语义
// 背景：原实现把 pattern 当正则做子串匹配——规则 'pnpm test' 会命中 'pnpm test && rm -rf /'
// 这类夹带命令；pattern='*' 更是等同于全放行。规则一律由审批时捕获的完整命令/路径字面量生成
// （见 main.js applyApprovalDecision），因此按「已批准前缀」匹配：整串相等，或后续字符为空白
// （命令参数），跨段夹带（&&/;/|）不命中。
function matchPattern(pattern, target) {
  const p = String(pattern ?? '').trim();
  const t = String(target ?? '').trim();
  if (!p || p === '*') return false; // 空/通配模式不再等同于全放行
  if (t === p) return true;
  if (!t.startsWith(p)) return false;
  const next = t.slice(p.length)[0];
  return next === ' ' || next === '\t';
}

// 审批摘要（供弹窗展示）
function approvalSummary(tool, args = {}) {
  switch (tool) {
    case 'shell':
      return { level: 'L1', title: '危险命令执行', detail: String(args.command || '').slice(0, 500) };
    case 'write_file':
      return { level: 'L2', title: '写入文件', detail: `${args.path || ''}\n\n${String(args.content || '').slice(0, 500)}` };
    case 'edit_file':
      return { level: 'L2', title: '编辑文件', detail: `${args.path || ''}\n查找：${String(args.search || '').slice(0, 200)}\n替换：${String(args.replace || '').slice(0, 200)}` };
    case 'apply_patch':
      return { level: 'L2', title: '应用补丁', detail: String(args.patch || '').slice(0, 800) };
    case 'git_commit':
      return { level: 'L2', title: 'Git 提交', detail: String(args.message || '').slice(0, 300) };
    case 'git_add':
      return { level: 'L2', title: 'Git 暂存', detail: String(args.files || '.') };
    case 'install_plugin': {
      const what = args.kind === 'mcp'
        ? `MCP 服务（npm 包 ${args.pkg || ''}，npx 启动）`
        : `技能（仓库 ${args.url || ''}）`;
      return {
        level: 'L3',
        title: '安装网络插件',
        detail: `将要安装：${what}\n来源：${args.url || args.pkg || ''}\n`
          + '安装动作含网络下载与本地落盘；技能内容会进入模型上下文（已做提示注入检测）。确认允许？',
      };
    }
    default:
      if (tool.startsWith('mcp__')) {
        return { level: 'L3', title: `MCP 工具 ${tool}`, detail: JSON.stringify(args).slice(0, 500) };
      }
      return { level: 'L2', title: tool, detail: JSON.stringify(args).slice(0, 500) };
  }
}

module.exports = { LEVELS, toolLevel, needsApproval, approvalTarget, matchPattern, approvalSummary, DANGEROUS_PATTERNS, READONLY_TOOLS };

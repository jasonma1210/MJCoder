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
  // PR 审查结论（APPROVE / REQUEST_CHANGES）对外可见、影响协作方判断，
  // 恒为 L3：不可经「本对话同类」规则静默放行（评论同理，防止误发）
  pr_review: 'L3', pr_comment: 'L3',
  // T4-1 Browser Use：全部纳入 L3 审批闸。navigate/screenshot/extract 可经规则豁免
  // （规则粒度=完整 URL/选择器前缀）；click/fill/select 由 browserTools 层恒逐次确认，
  // 不经 needsApproval——页面上的点击/输入可能触发支付、登录、发送等真实副作用。
  browser_navigate: 'L3', browser_screenshot: 'L3', browser_extract: 'L3',
  browser_click: 'L3', browser_fill: 'L3', browser_select: 'L3',
  // T4-2 Chrome 接管：连接授权 + 页面操作全部 L3。
  // chrome_connect 由 chromeRelay 恒逐次弹卡（授权只对当次连接有效，不经规则豁免）；
  // chrome_click/fill 由 chromeTools 层恒逐次确认——操作对象是用户真实浏览器（含登录态），
  // 风险高于 T4-1 的受控沙箱浏览器；tabs/navigate/screenshot/extract 走 L3 可规则豁免。
  // chrome_status 只读连接状态，不在审批面内。
  chrome_connect: 'L3',
  chrome_tabs: 'L3', chrome_navigate: 'L3', chrome_screenshot: 'L3', chrome_extract: 'L3',
  chrome_click: 'L3', chrome_fill: 'L3',
  // T4-7 Code Mode：普通代码 L3（可规则豁免，代码全文进审批卡摘要）；
  // 命中危险模式（child_process / 危险 shell 命令内嵌）的代码由 toolLevel 特判为 L1，
  // 恒逐次确认且不可豁免——与 shell 危险命令同纪律，宁可多问不可漏问。
  code_exec: 'L3',
  // V03（2026-10-16）：受限沙箱不可用时的单次非沙箱执行审批（显式逃生口，非隔离能力）。
  // L1：任何档位、任何规则都不可豁免；该审批只取 'once' 决策，从不进入 always/conversation 规则库。
  unconfined_exec: 'L1',
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
  // T4-7：Code Mode 危险代码判 L1（恒逐次、规则不可豁免），普通代码 L3（可豁免）
  if (tool === 'code_exec') return isDangerousCode(args.code) ? 'L1' : 'L3';
  if (tool.startsWith('mcp__')) return 'L3';
  return TOOL_LEVEL[tool] || 'L2';
}

// T4-7：代码危险面判定——两条通道：① Node 侧起进程/执行系统命令的 API 面
// （child_process / exec / spawn，含解构别名前的字面名——宁可误报）；
// ② 代码字符串里内嵌的危险 shell 命令（复用 dangerousPatterns 单一事实来源，
// rm -rf / sudo / curl|sh 出现在任何字符串字面量里都会命中）。
function isDangerousCode(code) {
  const s = String(code || '');
  if (/\bchild_process\b|\bexec(?:Sync)?\s*\(|\bspawn(?:Sync)?\s*\(|\bexecFile\b/.test(s)) return true;
  return DANGEROUS_PATTERNS.some((p) => p.test(s));
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
  if (tool === 'browser_navigate') return String(args.url || '');
  if (tool === 'browser_screenshot') return 'page';
  if (tool === 'browser_extract') return String(args.selector || 'page');
  // T4-2 Chrome 接管：规则粒度与 browser_* 对齐（URL 前缀/选择器/固定面）
  if (tool === 'chrome_connect') return String(args.userAgent || '');
  if (tool === 'chrome_navigate') return String(args.url || '');
  if (tool === 'chrome_screenshot') return 'page';
  if (tool === 'chrome_extract') return String(args.selector || 'page');
  if (tool === 'chrome_tabs') return 'tabs';
  // T4-7 Code Mode：规则粒度=代码前缀（matchPattern 前缀语义——批准过 200 字符前缀，
  // 后续代码只有以该前缀开头且边界为空白才豁免，防止「批准短代码后长代码静默放行」）
  if (tool === 'code_exec') return String(args.code || '').slice(0, 200);
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

// T4-1：浏览器操作敏感意图探测——URL/选择器/输入值命中支付、登录、发送类词，
// 审批卡加醒目警示行（词表刻意保守：宁可多警示，不可漏警示）
const BROWSER_SENSITIVE_RE = /(pay|payment|checkout|order|purchase|login|signin|sign[- ]?in|password|send|submit|transfer|withdraw|删除|支付|付款|下单|购买|登录|发送|提交|转账|提现)/i;
function browserSensitive(text) {
  return BROWSER_SENSITIVE_RE.test(String(text || ''))
    ? '\n\n⚠ 该操作可能触发支付/登录/发送类真实副作用，请确认页面与目标元素无误后再批准。'
    : '';
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
    // ── T4-1 Browser Use（L3 审批卡文案）──
    case 'browser_navigate':
      return {
        level: 'L3', title: '浏览器打开页面',
        detail: `将要访问：${String(args.url || '').slice(0, 300)}${browserSensitive(String(args.url || ''))}`,
      };
    case 'browser_click':
      return {
        level: 'L3', title: '浏览器点击',
        detail: `将在页面点击元素：${String(args.selector || '').slice(0, 200)}${browserSensitive(String(args.selector || ''))}`,
      };
    case 'browser_fill':
      return {
        level: 'L3', title: '浏览器填写表单',
        detail: `将在元素 ${String(args.selector || '').slice(0, 200)} 输入：${String(args.value || '').slice(0, 120)}${browserSensitive(`${args.selector || ''} ${args.value || ''}`)}`,
      };
    case 'browser_select':
      return {
        level: 'L3', title: '浏览器选择下拉项',
        detail: `将在元素 ${String(args.selector || '').slice(0, 200)} 选择：${JSON.stringify(args.value ?? '').slice(0, 120)}${browserSensitive(`${args.selector || ''} ${JSON.stringify(args.value ?? '')}`)}`,
      };
    case 'browser_screenshot':
      return { level: 'L3', title: '浏览器页面截图', detail: args.fullPage ? '截取整页（含未滚动区域）' : '截取当前视口' };
    case 'browser_extract':
      return {
        level: 'L3', title: '浏览器读取页面内容',
        detail: args.selector ? `读取元素：${String(args.selector).slice(0, 200)}` : '读取整页正文文本',
      };
    // ── T4-2 Chrome 接管（L3 审批卡文案）──
    case 'chrome_connect':
      return {
        level: 'L3', title: 'Chrome 接管连接请求',
        detail: `浏览器：${String(args.userAgent || '未知').slice(0, 160)}\n扩展：${String(args.extension || '')} v${String(args.version || '')}\n`
          + '批准后，MJ Code 可读取并操作你 Chrome 中的 http/https 标签页（包括登录态页面）。'
          + '点击/填写等写操作仍会逐次确认；本授权只对当前连接有效，断开后需重新批准。',
      };
    case 'chrome_tabs':
      return { level: 'L3', title: '读取 Chrome 标签页列表', detail: '将读取所有打开的 http/https 标签页的标题与地址（不读取页面内容）' };
    case 'chrome_navigate':
      return {
        level: 'L3', title: '在 Chrome 中打开页面',
        detail: `将在你的浏览器${args.tab_id != null ? `标签页 ${args.tab_id}` : '当前标签页'}访问：${String(args.url || '').slice(0, 300)}${browserSensitive(String(args.url || ''))}`,
      };
    case 'chrome_click':
      return {
        level: 'L3', title: 'Chrome 页面点击',
        detail: `将在你的浏览器页面点击元素：${String(args.selector || '').slice(0, 200)}${browserSensitive(String(args.selector || ''))}`,
      };
    case 'chrome_fill':
      return {
        level: 'L3', title: 'Chrome 页面填写',
        detail: `将在元素 ${String(args.selector || '').slice(0, 200)} 输入：${String(args.value || '').slice(0, 120)}${browserSensitive(`${args.selector || ''} ${args.value || ''}`)}`,
      };
    case 'chrome_screenshot':
      return {
        level: 'L3', title: 'Chrome 标签页截图',
        detail: `截取${args.tab_id != null ? `标签页 ${args.tab_id}` : '当前标签页'}视口（画面可能包含登录态、私人内容，请确认）`,
      };
    case 'chrome_extract':
      return {
        level: 'L3', title: '读取 Chrome 页面内容',
        detail: args.selector ? `读取元素：${String(args.selector).slice(0, 200)}` : '读取整页正文文本（登录态页面的内容也会回传给模型）',
      };
    // ── T4-7 Code Mode（L3/L1 审批卡文案：代码文本进摘要，危险代码额外警示行）──
    case 'code_exec': {
      const code = String(args.code || '');
      const danger = isDangerousCode(code);
      const shown = code.slice(0, 600) + (code.length > 600 ? '\n…（完整代码见工具参数）' : '');
      return {
        level: danger ? 'L1' : 'L3',
        title: danger ? '执行代码（命中危险模式）' : '执行代码（Code Mode）',
        detail: `代码执行会话跨调用保留状态${args.restart ? '；本次将先重置会话（旧状态丢弃）' : ''}。将要执行：\n${shown}`
          + (danger ? '\n注意：代码包含 child_process/危险命令等模式，恒逐次确认，不可被「始终允许」规则豁免。' : ''),
      };
    }
    // ── V03：受限沙箱不可用时的单次非沙箱执行审批卡 ──
    case 'unconfined_exec':
      return {
        level: 'L1',
        title: '非沙箱执行命令（单次）',
        detail: String(args.command || '').slice(0, 500)
          + '\n\n⚠ 当前环境无法提供 OS 级沙箱隔离。批准后该命令将以应用完整权限直接执行（无文件/网络边界）。'
          + '本批准仅对这一次命令有效，不会沉淀为「始终允许」规则。',
      };
    default:
      if (tool.startsWith('mcp__')) {
        return { level: 'L3', title: `MCP 工具 ${tool}`, detail: JSON.stringify(args).slice(0, 500) };
      }
      return { level: 'L2', title: tool, detail: JSON.stringify(args).slice(0, 500) };
  }
}

module.exports = { LEVELS, toolLevel, needsApproval, approvalTarget, matchPattern, approvalSummary, DANGEROUS_PATTERNS, READONLY_TOOLS, isDangerousCode };

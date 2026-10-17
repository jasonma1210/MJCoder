// 定时任务 / Worker 共用的工具集（一组「工具名 → 实现」映射）。
//
// 为什么独立成模块：main.js 已顶到 1500 行门禁，而这块与主进程其它逻辑零耦合，
// 只是把已有实现按 agent-core 的工具名组织起来。抽出来的同时把**能力清单的完整性**
// 变成可测对象（见 test/scheduled-tools.test.mjs）。
//
// 2026-10-17 事故：这里曾漏注入 webSearch / webFetch，导致「搜索最新 AI 新闻」的定时任务
// 直接回「web_search 工具不存在」——模型没撒谎，是宿主没给它工具。Worker 路径早已补上，
// 定时任务这条路径漏了。现在两条路径共用本模块，不会再各自维护一份清单。
const { denialText, approvalReasonOf } = require('./approvalChannel');
const { audit } = require('./audit/auditLog');

function scheduledToolHandlers(deps = {}) {
  const {
    scheduledAgentChat, webTools,
    toolShell, toolReadFile, runWriteTool, toolListDir, toolGrep, toolGlob,
    toolGitStatus, toolGitDiff, toolGitLog, toolGitBranch, toolGitCommit, toolGitAdd,
    callMcpTool, prTools,
  } = deps;
  return {
    chat: scheduledAgentChat,
    // P0-A：无人值守任务同样需要出网能力（查新闻/查文档/查报错）
    webSearch: (args) => webTools.webSearch(args),
    webFetch: (args) => webTools.webFetch(args),
    shell: toolShell,
    readFile: toolReadFile,
    writeFile: (args) => runWriteTool('writeFile', args),
    editFile: (args) => runWriteTool('editFile', args),
    applyPatch: (args) => runWriteTool('applyPatch', args),
    listDir: toolListDir,
    grep: toolGrep,
    glob: toolGlob,
    gitStatus: toolGitStatus,
    gitDiff: toolGitDiff,
    gitLog: toolGitLog,
    gitBranch: toolGitBranch,
    gitCommit: toolGitCommit,
    gitAdd: toolGitAdd,
    mcpCallTool: callMcpTool,
    prList: prTools.prList,
    prView: prTools.prView,
    prDiff: prTools.prDiff,
    prReview: prTools.prReview,
    prComment: prTools.prComment,
  };
}

module.exports = { scheduledToolHandlers, scheduledCreate };

// 模型侧「创建定时任务」工具的实现（agent-core 的 scheduled_create → 本函数）。
//
// 为什么必须弹审批：创建定时任务 = **持久化 + 未来无人值守自动执行**。用户不在场时它会自己跑，
// 等价于「给 AI 一个以后自己动手的长期授权」，不能由模型静默完成。
//
// 分级 L3（与审批中心一致：任何档位都弹卡），但**审批结果不落规则库**——不同于其它 L3 工具，
// 这里刻意不调用 applyApprovalDecision：若允许「本会话允许」，一次点击就能让模型在本会话内
// 静默建出任意多个无人值守任务。每次创建都问一次，是这类"长期授权"应有的成本。
async function scheduledCreate(args = {}, ctx = {}) {
  const schedule = String(args.schedule || '').trim();
  const prompt = String(args.prompt || '').trim();
  const name = String(args.name || '').trim() || (prompt.slice(0, 24) || '定时任务');
  if (!schedule || !prompt) return { ok: false, error: 'schedule 与 prompt 必填' };
  if (typeof ctx.cronValid === 'function' && !ctx.cronValid(schedule)) {
    return { ok: false, error: `Cron 表达式无效：「${schedule}」（需 5 段：分 时 日 月 周，如每天 09:41 写作 "41 9 * * *"）` };
  }

  const payload = { name, schedule, prompt, enabled: args.enabled !== false };
  // 用户明确选了「全不询问」（approvalMode=never）时不弹卡——产品不能对用户设置撒谎；
  // 其余所有档位一律弹卡（含 auto-safe：L3 不在自动放行之列）。
  if (ctx.approvalMode === 'never') {
    audit('scheduled_create', schedule, '审批档=never，按用户设置静默创建', 'auto');
    return finish('never');
  }
  if (typeof ctx.requestApproval !== 'function') {
    audit('scheduled_create', schedule, '审批通道不可用，fail-closed 拒绝', 'blocked');
    return { ok: false, error: '审批通道不可用，已阻止创建定时任务（无人值守任务不允许静默创建）' };
  }
  const decision = await ctx.requestApproval('scheduled_create', payload);
  if (decision === 'deny') {
    const reason = approvalReasonOf(decision);
    audit('scheduled_create', schedule, reason ? `用户拒绝。理由：${reason}` : '用户拒绝', 'denied');
    return { ok: false, error: denialText(reason), denied: true };
  }
  // 注意：此处**不**调用 applyApprovalDecision —— 审批只对本次有效，不落 always/conversation 规则。
  return finish(decision);

  function finish(applied) {
    const r = ctx.createTask ? ctx.createTask(payload) : { ok: false, error: '定时任务存储未就绪' };
    if (!r.ok) {
      audit('scheduled_create', schedule, `创建失败：${r.error}`, 'blocked');
      return { ok: false, error: r.error };
    }
    audit('scheduled_create', schedule, `已创建任务「${name}」（decision=${applied}）`, 'recorded');
    return {
      ok: true,
      taskId: r.task.id,
      message: `已创建定时任务「${name}」，计划 ${schedule}${payload.enabled ? '' : '（已暂停）'}。到点后由调度器无人值守执行。`,
    };
  }
}

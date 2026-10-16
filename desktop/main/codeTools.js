// T4-7：Code Mode 工具层（主进程侧）——code_exec 工具实现 + 审批闸 + 会话管理。
// 执行面（持久 vm 上下文）全部在 codeProcess 子进程（T3-6 驻留模式），
// 本模块只做：会话编排（每对话一个代码进程，cell 状态的载体就是进程本身）、
// 审批判定（危险代码 L1 恒逐次 / 普通代码 L3 可规则豁免，见 approval.js）、
// 审计留痕、saveImage 产物的预览句柄发放（复用 T3-1 mjpreview://，字节不过 IPC 消息体）、
// 大 stdout 无需处理——agentRunner 的 bigPayload.offloadToolCall 自动卸载（T3-1）。
// 降级语义：子进程死亡 = 会话状态丢失，不透明重启（host.js），
// 本层把会话从 Map 摘除并如实回传 degraded，模型可重跑或 restart:true 开新会话。
// 依赖注入 initCodeTools：{ requestApproval, applyApprovalDecision, getAlwaysRules, conversationRules, userDataDir }
const path = require('path');
const fs = require('fs');
const approval = require('./approval');
const { audit } = require('./audit/auditLog');
const codeProcess = require('./codeProcess/host');

let deps = null;
const sessions = new Map(); // conversationId -> { session, lastUsed }

// 闲置会话回收：30 分钟未用即 dispose（代码进程不无限驻留；状态随之丢弃）
const IDLE_TTL_MS = 30 * 60 * 1000;
let sweepTimer = null;

function initCodeTools(d) {
  deps = d;
  if (!sweepTimer) {
    sweepTimer = setInterval(sweepIdle, 5 * 60 * 1000);
    if (sweepTimer.unref) sweepTimer.unref();
  }
}

function sweepIdle() {
  const now = Date.now();
  for (const [key, rec] of sessions) {
    if (now - rec.lastUsed > IDLE_TTL_MS) {
      try { rec.session.dispose(); } catch { /* 已释放 */ }
      sessions.delete(key);
    }
  }
}

function disposeAll() {
  for (const [, rec] of sessions) {
    try { rec.session.dispose(); } catch { /* 已释放 */ }
  }
  sessions.clear();
}

// 会话键：测试注入面（deps.createSession）与真实会话分键空间，drop/get/dispose 三处同源
function keyFor(conversationId) {
  const key = String(conversationId || 'default');
  return typeof deps.createSession === 'function' ? `fake:${key}` : key;
}

function dropSession(conversationId) {
  const rec = sessions.get(keyFor(conversationId));
  if (rec) {
    try { rec.session.dispose(); } catch { /* 已释放 */ }
    sessions.delete(keyFor(conversationId));
  }
}

function getSession(conversationId) {
  // 测试注入面：deps.createSession 提供时用假会话（审批/编排逻辑可脱离真实子进程单测）
  if (typeof deps.createSession === 'function') {
    const key = keyFor(conversationId);
    let rec = sessions.get(key);
    if (!rec) {
      rec = { session: deps.createSession(), lastUsed: Date.now() };
      sessions.set(key, rec);
    }
    rec.lastUsed = Date.now();
    return rec.session;
  }
  if (!codeProcess.isAvailable()) {
    throw Object.assign(
      new Error('代码执行能力不可用（子进程宿主未就绪）：Code Mode 需要 Electron utilityProcess'),
      { codeDegraded: true },
    );
  }
  const key = keyFor(conversationId);
  let rec = sessions.get(key);
  if (!rec) {
    rec = { session: codeProcess.createSession(), lastUsed: Date.now() };
    sessions.set(key, rec);
  }
  rec.lastUsed = Date.now();
  return rec.session;
}

// 审批闸：普通代码 L3（可经「始终允许/本对话同类」规则豁免，同 browser_navigate——
// 代码内容全文进审批卡摘要，用户看得到再批）；危险代码（child_process/rm -rf 等）
// 由 approval.toolLevel 判为 L1，needsApproval 自动跳过规则豁免 → 恒逐次弹卡，fail-closed。
async function gateApproval(toolKey, args) {
  const { approvalMode = 'on-request', conversationId } = args;
  const verdict = approval.needsApproval({
    tool: toolKey, args, approvalMode, conversationId,
    alwaysRules: deps.getAlwaysRules(), conversationRules: deps.conversationRules,
  });
  if (verdict.need) {
    const decision = await deps.requestApproval(toolKey, args);
    if (decision === 'deny') {
      audit(toolKey, summarize(args), '用户拒绝', 'denied');
      return { ok: false, error: '用户拒绝执行', denied: true };
    }
    deps.applyApprovalDecision(decision, toolKey, args, conversationId);
  }
  return { allowed: true, asked: !!verdict.need, matched: verdict.matched || 'none' };
}

function summarize(args = {}) {
  const firstLine = String(args.code || '').split('\n')[0].slice(0, 80);
  return firstLine || 'code_exec';
}

// saveImage 产物 → 预览句柄（T3-1 同机制）：IPC 只带 URL，字节由渲染层按需加载
function grantImagePreviews(images) {
  if (!Array.isArray(images)) return [];
  const out = [];
  for (const im of images) {
    if (!im || !im.file) continue;
    let previewUrl = '';
    try {
      const { grantPreviewToken } = require('./previewScheme');
      previewUrl = grantPreviewToken(im.file);
    } catch (e) {
      console.warn('[codeTools] preview token grant failed (image still on disk):', e.message);
    }
    out.push({ name: im.name, bytes: im.bytes, previewUrl });
  }
  return out;
}

// ── code_exec 工具实现（agent-core toolHandlers 直挂）──
async function toolCodeExec(args = {}) {
  if (!deps) return { ok: false, error: '代码执行工具未初始化' };
  const { conversationId = '' } = args || {};
  const code = String(args.code == null ? '' : args.code);
  if (!code.trim()) return { ok: false, error: 'code 不能为空' };

  const gate = await gateApproval('code_exec', args);
  if (gate.ok === false) return gate;

  // restart：显式丢弃当前会话状态（模型发现状态脏了时的自救通道）
  if (args.restart) dropSession(conversationId);

  const outDir = path.join(deps.userDataDir, 'code-mode');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* 已存在 */ }

  let result;
  try {
    const session = getSession(conversationId);
    result = await session.call('exec', { code, timeoutMs: args.timeout, outDir });
  } catch (err) {
    const degraded = !!(err && (err.codeDegraded || err.codeChildDead));
    if (degraded) dropSession(conversationId); // 状态已丢：摘除死会话，下次调用自然新建
    audit('code_exec', summarize(args), `error: ${err.message}`, degraded ? 'degraded' : 'failed');
    return { ok: false, error: err.message, ...(degraded ? { degraded: true } : {}) };
  }

  const images = grantImagePreviews(result.images);
  // 代码本身报错也回传部分 stdout/images（调试信息对模型有用），但 ok=false
  if (!result.ok) {
    audit('code_exec', summarize(args), `code error: ${result.error}`, 'failed');
    return { ok: false, error: result.error, stdout: result.stdout, images };
  }
  audit('code_exec', summarize(args), 'ok', gate.asked ? 'approved' : 'recorded');
  return {
    ok: true,
    stdout: result.stdout,
    result: result.result,
    ...(result.resultTruncated ? { resultTruncated: true } : {}),
    images,
    elapsedMs: result.elapsedMs,
  };
}

module.exports = {
  initCodeTools, disposeAll, toolCodeExec,
  // 测试注入面
  _sessions: () => sessions,
};

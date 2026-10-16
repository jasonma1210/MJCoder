// T2-1：审计域（自主进程 main.js 原样搬移，行为不变）
// 审计上报：可丢失遥测。服务端不可达时熔断并静默，仅保留计数，绝不刷屏。
// 本地审计（P0-C）：无服务端令牌时落盘 userData/audit-log.jsonl（可丢失遥测，滚动上限 10MB）——
// 「本地优先」产品的最基本合规基线：纯本地场景（shell/写文件/git/MCP/审批放行）也必须留痕，
// 否则误操作或安全事件发生时无任何事后追溯材料。
//
// 依赖注入（沿用 orchestrator/memory 的 initXxx(deps) 模式）：
//   initAudit({ getAuthToken, serverBase }) —— main.js 在启动时接线；
//   authToken 归属 main.js（model:getSecrets 拉取成功后赋值），本模块只读。
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const degrade = require('../degrade');

const AUDIT_BREAKER_THRESHOLD = 3;
let auditFailures = 0;
let auditBreakerUntil = 0;

const AUDIT_LOG_FILE = () => path.join(app.getPath('userData'), 'audit-log.jsonl');
const AUDIT_LOG_MAX_BYTES = 10 * 1024 * 1024;
let auditLogBytes = -1; // 懒加载：首次写入时探测现有体积

let deps = null;
function initAudit(d) { deps = d; } // { getAuthToken: () => string, serverBase: () => string }

function auditLocal(action, target, detail, approvalResult) {
  try {
    const file = AUDIT_LOG_FILE();
    fs.mkdirSync(path.dirname(file), { recursive: true }); // userData 理论上恒存在，防御性确保
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      action,
      target: String(target || '').slice(0, 500),
      detail: String(detail || '').slice(0, 2000),
      approval_result: approvalResult || 'auto',
      mode: 'local',
    }) + '\n';
    if (auditLogBytes < 0) {
      try { auditLogBytes = fs.statSync(file).size; } catch (e) { auditLogBytes = 0; }
    }
    if (auditLogBytes + Buffer.byteLength(line) > AUDIT_LOG_MAX_BYTES) {
      // 滚动：旧文件转 .1（只保留一代），重新计数
      try { fs.renameSync(file, `${file}.1`); } catch (e) { /* 不存在则忽略 */ }
      auditLogBytes = 0;
    }
    fs.appendFileSync(file, line);
    auditLogBytes += Buffer.byteLength(line);
  } catch (e) {
    console.warn('[audit] 本地审计落盘失败:', e.message); // 审计失败绝不阻塞主流程
  }
}

function audit(action, target, detail, approvalResult) {
  if (!deps.getAuthToken()) { auditLocal(action, target, detail, approvalResult); return; } // 本地优先：无令牌时落盘留痕
  if (Date.now() < auditBreakerUntil) { auditFailures++; return; } // 熔断期内不再发起连接
  fetch(`${deps.serverBase()}/audit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deps.getAuthToken()}` },
    body: JSON.stringify({
      action,
      target: String(target || '').slice(0, 500),
      detail: String(detail || '').slice(0, 2000),
      approval_result: approvalResult || 'auto',
    }),
    signal: AbortSignal.timeout(3000),
  }).then(() => {
    if (auditFailures) degrade.markHealthy('audit');
    auditFailures = 0;
    auditBreakerUntil = 0;
  }).catch((err) => {
    auditFailures++;
    const degradable = degrade.report('audit', err, { silent: true });
    if (degradable && auditFailures >= AUDIT_BREAKER_THRESHOLD) {
      auditBreakerUntil = Date.now() + 5 * 60 * 1000; // 连续失败 → 熔断 5 分钟
      console.warn(`[audit] 审计上报连续失败 ${auditFailures} 次（服务端不可达），已熔断 5 分钟`);
    }
  });
}

module.exports = { initAudit, audit, auditLocal };

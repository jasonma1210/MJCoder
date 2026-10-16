// T2-6：诊断包一键导出（设置页 → 导出诊断包）
// 打包内容（全部本机文件，zip 落在 userData/diagnostics/，用户自愿提交给开发者）：
//   audit/       本地审计日志（audit-log.jsonl[.1]，已脱敏截断）
//   diagnostics/ 崩溃/异常聚合 JSONL（T2-5）
//   traces/      运行 trace（T0-5，逐轮引擎事件）
//   logs/        主进程 console tee（最近 3 个）
//   config/      脱敏配置：providers（去 keyEncrypted/api_key）、preferences、projects、
//                models.json（去 api_key）、mcp-servers.json（去 env 与 headers）
//   meta.json    版本/平台/架构/导出时间
// 凭证纪律：**任何 API Key / 加密密文 / env 变量 / Authorization 头都不进包**。
// 测试 test/diag-export.test.mjs 用假密钥值 grep 全包，命中即红。
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { writeZip } = require('./zipStore');

// 需要整体剔除的敏感字段名（大小写不敏感匹配）
const SENSITIVE_KEYS = new Set(['api_key', 'apikey', 'keyencrypted', 'api_key_encrypted', 'token', 'password', 'secret', 'env', 'headers', 'authorization']);

// 递归脱敏：剔除敏感字段（对象/数组通用）
function redact(node) {
  if (Array.isArray(node)) return node.map(redact);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) continue;
      out[k] = redact(v);
    }
    return out;
  }
  return node;
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// 收集诊断条目（纯函数，userData 显式传入便于测试）
function collectEntries(userData) {
  const entries = [];
  const push = (name, data) => entries.push({ name, data });

  // meta.json：环境指纹
  push('meta.json', JSON.stringify({
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron || 'n/a',
    node: process.versions.node,
    userData,
  }, null, 2));

  // 审计日志（本地优先留痕，T2-6 前已脱敏截断）
  for (const f of ['audit-log.jsonl', 'audit-log.jsonl.1']) {
    const p = path.join(userData, f);
    if (fs.existsSync(p)) push(`audit/${f}`, fs.readFileSync(p));
  }

  // 崩溃/异常聚合（T2-5）
  const diagDir = path.join(userData, 'diagnostics');
  for (const f of listFiles(diagDir, (n) => n.startsWith('crash-') && n.endsWith('.jsonl'))) {
    push(`diagnostics/${f}`, fs.readFileSync(path.join(diagDir, f)));
  }

  // 运行 trace（T0-5）：最多最近 10 个文件，防包体膨胀
  const traceDir = path.join(userData, 'traces');
  const traceFiles = listFiles(traceDir, (n) => n.endsWith('.jsonl'))
    .map((f) => ({ f, m: fs.statSync(path.join(traceDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, 10);
  for (const { f } of traceFiles) push(`traces/${f}`, fs.readFileSync(path.join(traceDir, f)));

  // 主进程 console 日志：最近 3 个
  const logsDir = path.join(userData, 'logs');
  const logFiles = listFiles(logsDir, (n) => n.startsWith('main-') && n.endsWith('.log'))
    .map((f) => ({ f, m: fs.statSync(path.join(logsDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, 3);
  for (const { f } of logFiles) push(`logs/${f}`, fs.readFileSync(path.join(logsDir, f)));

  // 脱敏配置：local-data.json 只取配置三域（providers/preferences/projects），
  // 会话与消息正文**不进包**（诊断不需要，且是用户最大面积的数据）
  const localData = readJsonSafe(path.join(userData, 'local-data.json'));
  if (localData) {
    push('config/local-data.json', JSON.stringify({
      providers: redact(localData.providers || []),
      preferences: redact(localData.preferences || {}),
      projects: redact(localData.projects || []),
    }, null, 2));
  }

  // models.json（~/.mjcode/models.json）：可能含明文 Key，整体剔除 api_key 字段
  const modelsPath = path.join(app.getPath('home'), '.mjcode', 'models.json');
  const modelsRaw = readJsonSafe(modelsPath);
  if (modelsRaw != null) push('config/models.json', JSON.stringify(redact(modelsRaw), null, 2));

  // mcp-servers.json：env 与 headers 整体剔除（可含密钥/Authorization）
  const mcpRaw = readJsonSafe(path.join(userData, 'mcp-servers.json'));
  if (mcpRaw != null) push('config/mcp-servers.json', JSON.stringify(redact(mcpRaw), null, 2));

  return entries;
}

function listFiles(dir, pred) {
  try { return fs.readdirSync(dir).filter(pred); } catch { return []; }
}

// 导出诊断包 zip，返回落盘路径
function exportDiagnosticsZip() {
  const userData = app.getPath('userData');
  const entries = collectEntries(userData);
  const outDir = path.join(userData, 'diagnostics');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `diagnostics-${Date.now()}.zip`);
  writeZip(entries, outPath);
  return outPath;
}

// IPC 接线（main.js 调用）
function registerDiagExportIpc() {
  const { ipcMain } = require('electron');
  ipcMain.handle('diag:export', async () => {
    try {
      const file = exportDiagnosticsZip();
      return { ok: true, file };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });
}

module.exports = { exportDiagnosticsZip, registerDiagExportIpc, collectEntries, redact, SENSITIVE_KEYS };

// 定时任务输出落盘：~/Documents/.MJCoder/tasks/<任务名>/<YYYY-MM-DD>.md
//
// 为什么需要：定时任务在无人值守下跑完，结果只存在任务对象里（last_result 截断到 500 字符），
// 用户在应用外没有任何可查阅的产出。这里把每次运行的完整输出按「任务名 + 日期」归档，
// 同一天多次运行追加到同一个文件，形成可翻查的日志。
//
// 纪律：
//   · 目录名必须消毒（防路径穿越 / 非法字符 / Windows 保留名）；
//   · 写盘失败只告警，绝不影响任务本身的成败判定；
//   · 失败运行同样记录（带失败原因），否则「今天为什么没结果」无从追查。
const fs = require('fs');
const path = require('path');

const ROOT_DIR = '.MJCoder';
const SUB_DIR = 'tasks';
const MAX_NAME = 60;
// Windows 保留设备名：即便在类 Unix 上也统一处理，避免同一份数据跨平台不可用
const RESERVED = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

// 任务名 → 目录名：去掉路径分隔符与控制字符，剥掉前导点（隐藏目录/`..`），兜空与保留名
function safeTaskDirName(name) {
  const cleaned = String(name || '')
    // 这里的控制字符范围是**故意的**：清理任务名里的 \x00-\x1f 才安全
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\.{2,}/g, '_') // 连续点（`..` 片段）直接抹平：即使没有分隔符也不留可疑目录名
    .replace(/^[.\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME)
    .replace(/[.\s]+$/, '');
  // 只剩分隔符残留（`..` / `_ _`）的名字没有可读性，统一回落 untitled
  if (!cleaned || /^[_.\s]+$/.test(cleaned)) return 'untitled';
  return RESERVED.has(cleaned.toLowerCase()) ? `${cleaned}_task` : cleaned;
}

// 当天归档文件路径（导出便于单测与「打开所在目录」等 UI 复用）
function taskOutputPath(baseDir, taskName, date = localDate()) {
  return path.join(baseDir, ROOT_DIR, SUB_DIR, safeTaskDirName(taskName), `${date}.md`);
}

function humanDuration(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s % 60)}s`;
}

// 一次运行的 Markdown 片段：标题行写清「何时 / 成败 / 花多少」，正文是完整输出
function renderRunSection(run, at = new Date()) {
  const ok = run.status === 'success';
  const head = `## ${localTime(at)} · ${ok ? '成功' : '失败'}`;
  const meta = [
    `- 触发：${run.trigger || 'scheduled'}`,
    `- 耗时：${humanDuration(run.duration_ms)}`,
    run.tokens && (run.tokens.prompt_tokens || run.tokens.completion_tokens)
      ? `- tokens：${Number(run.tokens.prompt_tokens || 0).toLocaleString()} in / ${Number(run.tokens.completion_tokens || 0).toLocaleString()} out`
      : null,
    Number.isFinite(run.tools) ? `- 工具调用：${run.tools} 次` : null,
    ok ? null : `- 失败原因：${String(run.error || '未提供').slice(0, 500)}`,
  ].filter(Boolean).join('\n');
  const body = ok
    ? String(run.output || '（本次运行没有产出文本）').trim()
    : String(run.output || '').trim() || '（无输出）';
  return `${head}\n\n${meta}\n\n${body}\n\n`;
}

// 追加一次运行记录到当天文件；首次写入时补文件头（任务名 + 日期 + 计划）
async function appendRunRecord({ baseDir, taskName, schedule, run, at = new Date() }) {
  if (!baseDir) return { ok: false, error: '未取到文档目录' };
  const file = taskOutputPath(baseDir, taskName, localDate(at));
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true });
  let prefix = '';
  try {
    await fs.promises.access(file);
  } catch {
    prefix = `# ${String(taskName || '定时任务')} · ${localDate(at)}\n\n`
      + `- 计划：\`${String(schedule || '')}\`\n\n---\n\n`;
  }
  await fs.promises.appendFile(file, prefix + renderRunSection(run, at), 'utf8');
  return { ok: true, file };
}

module.exports = {
  ROOT_DIR, SUB_DIR, safeTaskDirName, taskOutputPath, renderRunSection, appendRunRecord, localDate, localTime,
};

#!/usr/bin/env node
// MJ Code Eval Runner（P0-质量证明体系）
// 主流设计（SWE-bench 风格）：任务 = 初始代码库快照 + 自然语言问题陈述 + fail-to-pass 验证脚本。
// 每个任务在隔离临时目录物化 fixture → 由 agent-core.runAgent（与桌面端同一引擎）驱动工具循环修复
// → 执行 verify 命令判定通过。产出 JSON + Markdown 报告（成功率/轮次/token/耗时）。
//
// 用法：
//   node eval/run-eval.mjs --check                          # 零成本自检：任务 schema + fixture 完整性 + fail-to-pass 基线校验
//   node eval/run-eval.mjs --base-url https://api.deepseek.com --model deepseek-chat --api-key sk-xxx
//   可选：--tasks <path> --only <task-id,...> --max-rounds 15 --timeout 600 --limit N
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentCorePath = path.join(__dirname, '..', 'agent-core', 'index.js');
const { runAgent, BASE_TOOLS } = await import('file://' + agentCorePath);

const DEFAULT_TASKS = path.join(__dirname, 'tasks.json');
const RESULTS_DIR = path.join(__dirname, 'results');
const VALID_CATEGORIES = ['bugfix', 'feature', 'refactor'];

// ── CLI ──
function parseArgs(argv) {
  const args = { maxRounds: 15, timeout: 600, tasks: DEFAULT_TASKS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (a === '--base-url') args.baseUrl = argv[++i];
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--api-key') args.apiKey = argv[++i];
    else if (a === '--tasks') args.tasks = argv[++i];
    else if (a === '--only') args.only = String(argv[++i]).split(',').map((s) => s.trim());
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--max-rounds') args.maxRounds = Number(argv[++i]);
    else if (a === '--timeout') args.timeout = Number(argv[++i]);
    else { console.error(`未知参数: ${a}`); process.exit(2); }
  }
  // run 模式必填项
  if (!args.check) {
    args.baseUrl = args.baseUrl || process.env.MJ_EVAL_BASE_URL;
    args.model = args.model || process.env.MJ_EVAL_MODEL;
    args.apiKey = args.apiKey || process.env.MJ_EVAL_API_KEY;
    if (!args.baseUrl || !args.model) {
      console.error('run 模式需要 --base-url 与 --model（或环境变量 MJ_EVAL_BASE_URL / MJ_EVAL_MODEL）');
      process.exit(2);
    }
  }
  return args;
}

// ── 任务加载与 schema 校验 ──
function loadTasks(file) {
  if (!fs.existsSync(file)) throw new Error(`任务文件不存在: ${file}`);
  const tasks = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('任务文件必须是非空数组');
  const ids = new Set();
  const problems = [];
  for (const t of tasks) {
    const where = t.id || '(无 id)';
    if (!t.id || !/^[a-z0-9-]+$/.test(t.id)) problems.push(`${where}: id 缺失或含非法字符`);
    if (ids.has(t.id)) problems.push(`${where}: id 重复`);
    ids.add(t.id);
    if (!VALID_CATEGORIES.includes(t.category)) problems.push(`${where}: category 必须是 ${VALID_CATEGORIES.join('/')}`);
    if (!t.prompt || String(t.prompt).length < 20) problems.push(`${where}: prompt 缺失或过短`);
    if (!Array.isArray(t.files) || t.files.length === 0) problems.push(`${where}: files 为空`);
    else for (const f of t.files) {
      if (!f.path || typeof f.content !== 'string') problems.push(`${where}: 文件条目缺少 path/content`);
      if (f.path && (f.path.includes('..') || path.isAbsolute(f.path))) problems.push(`${where}: 文件路径越界 ${f.path}`);
    }
    const v = t.verify || {};
    if (!v.command) problems.push(`${where}: verify.command 缺失`);
    if (v.expect_exit !== 0) problems.push(`${where}: expect_exit 必须为 0（fail-to-pass 口径）`);
    if (v.baseline_should_fail !== true) problems.push(`${where}: baseline_should_fail 必须为 true（保证任务可判定）`);
  }
  return { tasks, problems };
}

// ── fixture 物化：任务 → 隔离临时工作区 ──
function materialize(task) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `mj-eval-${task.id}-`));
  for (const f of task.files) {
    const target = path.join(ws, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content, 'utf8');
  }
  return ws;
}

function runCommand(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = execFile('bash', ['-c', cmd], { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ exitCode: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0), stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    child.on('error', () => {}); // timeout 情况已由回调 err 承接
  });
}

// ── Node 版工具处理器（与 main.js 同语义的最小实现，cwd 锁定任务工作区）──
function makeToolHandlers(ws, chatOptions) {
  const safeJoin = (p) => {
    const target = path.resolve(ws, String(p || ''));
    if (!target.startsWith(ws)) throw new Error(`路径越界: ${p}`);
    return target;
  };
  return {
    // 模型通道：OpenAI 兼容 chat/completions（非流式，工具循环由 runAgent 驱动）
    async chat({ baseUrl, messages, model, tools }) {
      const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(chatOptions.apiKey ? { Authorization: `Bearer ${chatOptions.apiKey}` } : {}),
        },
        body: JSON.stringify({ model, messages, tools: tools || undefined }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`模型 API ${res.status}: ${text.slice(0, 300)}`);
      }
      const j = await res.json();
      const msg = j.choices?.[0]?.message || {};
      return {
        content: msg.content || '',
        tool_calls: (msg.tool_calls || []).map((tc, i) => ({
          id: tc.id || `call_${i}`,
          function: { name: tc.function?.name, arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}) },
        })),
        usage: j.usage ? { prompt_tokens: j.usage.prompt_tokens || 0, completion_tokens: j.usage.completion_tokens || 0 } : null,
        aborted: false,
      };
    },
    // shell：execFile bash -c，cwd 恒为任务工作区（子路径允许）
    async shell({ command, cwd: sub }) {
      const dir = sub ? safeJoin(sub) : ws;
      return await new Promise((resolve) => {
        execFile('bash', ['-c', String(command || '')], { cwd: dir, timeout: 60000, maxBuffer: 1024 * 1024 },
          (err, stdout, stderr) => resolve({ output: String(stdout || '') + (String(stderr || '') ? `\n[stderr] ${stderr}` : ''), exitCode: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0) }));
      });
    },
    async readFile({ path: p, offset, limit }) {
      const content = fs.readFileSync(safeJoin(p), 'utf8');
      const lines = content.split('\n');
      if (offset !== undefined && limit !== undefined) return { content: lines.slice(offset, offset + limit).join('\n'), totalLines: lines.length };
      return { content, totalLines: lines.length };
    },
    async writeFile({ path: p, content }) {
      const target = safeJoin(p);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(content ?? ''), 'utf8');
      return { ok: true };
    },
    async editFile({ path: p, search, replace }) {
      const target = safeJoin(p);
      const src = fs.readFileSync(target, 'utf8');
      if (!src.includes(search)) throw new Error('未找到要替换的内容');
      fs.writeFileSync(target, src.replace(search, replace), 'utf8');
      return { ok: true };
    },
    async applyPatch({ patch, cwd: sub }) {
      const dir = sub ? safeJoin(sub) : ws;
      return await new Promise((resolve) => {
        const child = spawn('patch', ['-p1', '--no-backup-if-mismatch'], { cwd: dir });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        const timer = setTimeout(() => { child.kill(); resolve({ output: 'patch 执行超时' }); }, 30000);
        child.on('close', (code) => { clearTimeout(timer); resolve({ output: stdout + stderr, exitCode: code ?? 0 }); });
        child.stdin.write(String(patch || ''));
        child.stdin.end();
      });
    },
    async listDir({ path: p }) {
      const entries = fs.readdirSync(p ? safeJoin(p) : ws, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    },
    async grep({ pattern, path: p }) {
      const root = p ? safeJoin(p) : ws;
      const re = new RegExp(String(pattern || ''), 'i');
      const hits = [];
      const walk = (dir, depth) => {
        if (depth > 6 || hits.length > 200) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name === 'node_modules' || e.name === '.git') continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full, depth + 1);
          else {
            try {
              const src = fs.readFileSync(full, 'utf8');
              src.split('\n').forEach((line, i) => { if (re.test(line)) hits.push(`${full}:${i + 1}: ${line.trim().slice(0, 200)}`); });
            } catch { /* 二进制/不可读文件跳过 */ }
          }
        }
      };
      walk(root, 0);
      return { matches: hits.join('\n') };
    },
    async glob({ pattern, path: p }) {
      const root = p ? safeJoin(p) : ws;
      const re = globToRegExp(String(pattern || '*'));
      const out = [];
      const walk = (dir, depth) => {
        if (depth > 6 || out.length > 500) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name === 'node_modules' || e.name === '.git') continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full, depth + 1);
          else if (re.test(e.name)) out.push(path.relative(root, full));
        }
      };
      walk(root, 0);
      return { files: out };
    },
  };
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

// eval 只暴露核心编码工具子集（与同类公开基准一致：不给 git/子代理，避免外部状态依赖）
const EVAL_TOOL_NAMES = new Set(['shell', 'read_file', 'write_file', 'edit_file', 'apply_patch', 'list_dir', 'grep', 'glob']);
const evalTools = BASE_TOOLS.filter((t) => EVAL_TOOL_NAMES.has(t.function.name));

// ── 单任务执行 ──
async function runOne(task, args) {
  const ws = materialize(task);
  const started = Date.now();
  let rounds = 0;
  const handlers = makeToolHandlers(ws, { apiKey: args.apiKey });
  const baseChat = handlers.chat;
  handlers.chat = async (payload) => { rounds += 1; return baseChat(payload); };

  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  let finalText = '';
  let error = null;
  const ctrl = new AbortController();
  const watchdog = setTimeout(() => ctrl.abort(), args.timeout * 1000);
  try {
    finalText = await runAgent({
      messages: [{ role: 'user', content: task.prompt }],
      model: { provider: { id: 'eval', base_url: args.baseUrl, isGlobal: false }, model: { model_id: args.model } },
      tools: evalTools,
      toolHandlers: handlers,
      maxRounds: args.maxRounds,
      signal: ctrl.signal,
      cwd: ws,
      // usage 由 runAgent 在结束时回传（onDone），缺失则报告 token 恒 0
      onDone: (_text, u) => { if (u) usage = { prompt_tokens: u.prompt_tokens || 0, completion_tokens: u.completion_tokens || 0 }; },
      systemPrompt: `你是 MJ Coder 的自动评测模式。你在隔离沙箱中处理一个编码任务：阅读代码、定位问题、修改源码（禁止修改 verify.js），用 shell 运行 node verify.js 自检，直到通过。完成后简述修改内容。`,
    });
  } catch (e) {
    error = e.message;
  } finally {
    clearTimeout(watchdog);
  }
  const verify = await runCommand(task.verify.command, ws, 30000);
  const seconds = Math.round((Date.now() - started) / 1000);
  fs.rmSync(ws, { recursive: true, force: true });
  // 判定口径：pass=通过 / fail=做错了 / error=端点或引擎不可用（不得计入能力评分）
  const passed = verify.exitCode === 0;
  const status = passed ? 'pass' : (error || rounds === 0 ? 'error' : 'fail');
  return {
    id: task.id, category: task.category,
    passed, status,
    aborted: ctrl.signal.aborted,
    rounds, seconds, error,
    prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens,
    verify_exit: verify.exitCode,
    verify_output: (verify.stdout + verify.stderr).slice(-500),
    final_text: String(finalText || '').slice(0, 300),
  };
}

// ── 报告 ──
function writeReport(results, args, durationSec) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  // 时间戳精确到毫秒 + pid：并发/连续运行时避免报告文件互相覆盖
  const ts = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${Date.now().toString(36)}${process.pid}`;
  const passed = results.filter((r) => r.passed).length;
  const errored = results.filter((r) => r.status === 'error').length;
  const failed = results.length - passed - errored;
  const resolved = passed + failed; // 可判定任务数（排除端点不可用）
  const byCat = {};
  for (const c of VALID_CATEGORIES) {
    const list = results.filter((r) => r.category === c);
    if (list.length) byCat[c] = `${list.filter((r) => r.passed).length}/${list.length}`;
  }
  const summary = {
    ts, model: args.model || '(check)', base_url: args.baseUrl || '',
    total: results.length, passed, failed, errored,
    success_rate: `${resolved ? Math.round((passed / resolved) * 100) : 0}%`,
    unavailable: errored === results.length, // 全部因端点/引擎不可用而失败 → 该档不可评分
    by_category: byCat, duration_sec: durationSec,
    tokens: {
      prompt: results.reduce((a, r) => a + r.prompt_tokens, 0),
      completion: results.reduce((a, r) => a + r.completion_tokens, 0),
    },
  };
  const jsonFile = path.join(RESULTS_DIR, `eval-report-${ts}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify({ summary, results }, null, 2));
  const lines = [
    `# MJ Code Eval 报告（${summary.ts}）`,
    '',
    `- 模型：${summary.model}`,
    `- 通过率：${summary.passed}/${summary.total}（${summary.success_rate}）${summary.errored ? `｜不可用/异常 ${summary.errored} 题（不计入通过率）` : ''}${summary.unavailable ? '｜该端点不可用，本轮不可评分' : ''}`,
    `- 分类：${Object.entries(byCat).map(([k, v]) => `${k} ${v}`).join(' ｜ ') || '—'}`,
    `- 总耗时：${durationSec}s｜tokens：${summary.tokens.prompt} in / ${summary.tokens.completion} out`,
    '',
    '| 任务 | 分类 | 结果 | 轮次 | 耗时 | 备注 |',
    '|------|------|------|------|------|------|',
    ...results.map((r) => `| ${r.id} | ${r.category} | ${r.status === 'pass' ? 'PASS' : (r.status === 'error' ? 'ERROR' : 'FAIL')} | ${r.rounds} | ${r.seconds}s | ${r.error || (r.passed ? '' : r.verify_output.split('\n').pop() || '')} |`),
  ];
  const mdFile = path.join(RESULTS_DIR, `eval-report-${ts}.md`);
  fs.writeFileSync(mdFile, lines.join('\n') + '\n');
  return { summary, mdFile, jsonFile };
}

// ── main ──
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { tasks, problems } = loadTasks(args.tasks);
  let list = tasks;
  if (args.only) list = tasks.filter((t) => args.only.includes(t.id));
  if (args.limit) list = list.slice(0, args.limit);
  if (list.length === 0) { console.error('没有匹配的任务'); process.exit(2); }

  // 自检模式：schema + fixture 物化 + fail-to-pass 基线（verify 必须初始失败）
  if (args.check) {
    if (problems.length) {
      console.error('任务 schema 校验失败：');
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    let baselineIssues = 0;
    for (const t of list) {
      const ws = materialize(t);
      const r = await runCommand(t.verify.command, ws, 30000);
      const failToPass = t.verify.baseline_should_fail && r.exitCode !== 0;
      if (!failToPass) { baselineIssues += 1; console.error(`  [FAIL] ${t.id}: 基线 verify 退出码 ${r.exitCode}（要求非 0），输出：${(r.stdout + r.stderr).slice(-200)}`); }
      else console.log(`  [OK]   ${t.id}: 基线按预期失败（exit ${r.exitCode}）→ 可判定`);
      fs.rmSync(ws, { recursive: true, force: true });
    }
    console.log(`\n自检完成：${list.length} 个任务，${problems.length ? 'schema 有误' : 'schema 通过'}，${baselineIssues === 0 ? 'fail-to-pass 基线全部成立' : `${baselineIssues} 个任务基线不可判定`}`);
    process.exit(problems.length || baselineIssues ? 1 : 0);
  }

  // 运行模式
  const started = Date.now();
  const results = [];
  for (const t of list) {
    process.stdout.write(`▶ ${t.id} ... `);
    const r = await runOne(t, args);
    results.push(r);
    const verdict = r.status === 'pass' ? 'PASS' : (r.status === 'error' ? 'ERROR（端点/引擎不可用，不计入通过率）' : 'FAIL');
    console.log(`${verdict}（verify exit ${r.verify_exit}${r.error ? '，' + r.error : ''}）`);
  }
  const durationSec = Math.round((Date.now() - started) / 1000);
  const { summary, mdFile } = writeReport(results, args, durationSec);
  console.log(`\n完成：${summary.passed}/${summary.total}（${summary.success_rate}）`);
  console.log(`报告：${mdFile}`);
}

main().catch((e) => { console.error('[eval] 执行失败:', e.message); process.exit(1); });

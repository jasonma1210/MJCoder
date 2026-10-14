#!/usr/bin/env node
// MJ Code Eval 对照脚本（P0-质量证明体系的对外可用性）
// 目的：同一批任务 × 多个模型/端点，横向产出「成功率 × 耗时 × token × 成本」对比表。
// 对照组的意义：没有对照的 100% 没有说服力——本脚本让「MJ Code harness + 任意模型」可被横向比较。
//
// 用法：
//   node eval/run-compare.mjs --profiles eval/profiles.json --tasks eval/tasks.json
//   node eval/run-compare.mjs --profiles eval/profiles.json --tasks eval/tasks-hard.json --limit 3
//
// 凭据安全：profiles.json 只存端点/模型/单价与「API Key 所在环境变量名」，
//           真实的 Key 只从 process.env 读取，不落文件、不进仓库。
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'results');

function parseArgs(argv) {
  const args = { profiles: path.join(__dirname, 'profiles.json'), tasks: path.join(__dirname, 'tasks.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profiles') args.profiles = argv[++i];
    else if (a === '--tasks') args.tasks = argv[++i];
    else if (a === '--only') args.only = String(argv[++i]);
    else if (a === '--limit') args.limit = String(argv[++i]);
    else { console.error(`未知参数: ${a}`); process.exit(2); }
  }
  return args;
}

// profiles 校验：缺字段或非法单价直接 fail-closed，不静默跳过
function loadProfiles(file) {
  if (!fs.existsSync(file)) {
    console.error(`缺少 profiles 文件：${file}\n请复制 eval/profiles.example.json 为 eval/profiles.json 后填写（Key 只写环境变量名）。`);
    process.exit(2);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(data) ? data : (data.profiles || []);
  if (!Array.isArray(list) || list.length === 0) { console.error('profiles 为空数组'); process.exit(2); }
  const problems = [];
  const profiles = list.map((p, i) => {
    const where = p.name || `#${i}`;
    if (!p.base_url) problems.push(`${where}: 缺少 base_url`);
    if (!p.model) problems.push(`${where}: 缺少 model`);
    if (p.price_in !== undefined && typeof p.price_in !== 'number') problems.push(`${where}: price_in 必须是数字`);
    if (p.price_out !== undefined && typeof p.price_out !== 'number') problems.push(`${where}: price_out 必须是数字`);
    const key = p.api_key_env ? process.env[p.api_key_env] : '';
    // 缺 Key 只跳过该档（本地 Ollama 等无 Key 端点不受影响），不中止整轮对照
    if (p.api_key_env && !key) console.warn(`[compare] 跳过 ${where}：环境变量 ${p.api_key_env} 未设置`);
    return {
      name: p.name || `${p.model}@${p.base_url}`,
      base_url: p.base_url,
      model: p.model,
      api_key_env: p.api_key_env || '',
      apiKey: key,
      price_in: typeof p.price_in === 'number' ? p.price_in : 0,
      price_out: typeof p.price_out === 'number' ? p.price_out : 0,
    };
  });
  if (problems.length) {
    console.error('profiles 校验失败：');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(2);
  }
  return profiles.filter((p) => !p.api_key_env || p.apiKey);
}

// 逐个 profile 跑 run-eval.mjs（子进程隔离，失败不影响其他 profile）
function runProfile(profile, args) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const argv = [path.join(__dirname, 'run-eval.mjs', ), '--base-url', profile.base_url, '--model', profile.model, '--tasks', args.tasks];
    if (args.only) argv.push('--only', args.only);
    if (args.limit) argv.push('--limit', args.limit);
    const env = { ...process.env, ...(profile.apiKey ? { MJ_EVAL_API_KEY: profile.apiKey } : {}) };
    const child = spawn(process.execPath, argv, { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); process.stdout.write(d); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('close', () => {
      // 取本次运行期间生成的最新报告
      let report = null;
      try {
        const files = fs.readdirSync(RESULTS_DIR)
          .filter((f) => f.startsWith('eval-report-') && f.endsWith('.json'))
          .map((f) => ({ f, m: fs.statSync(path.join(RESULTS_DIR, f)).mtimeMs }))
          .filter((x) => x.m >= startedAt - 1000)
          .sort((a, b) => b.m - a.m);
        if (files.length) report = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, files[0].f), 'utf8'));
      } catch (e) {
        console.warn('[compare] 报告读取失败:', e.message);
      }
      resolve({ profile, report, raw: out });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profiles = loadProfiles(args.profiles);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const rows = [];
  for (const p of profiles) {
    console.log(`\n=== ${p.name} ===`);
    const { report } = await runProfile(p, args);
    if (!report || !report.summary) {
      console.warn(`[compare] ${p.name} 未产出报告，已跳过`);
      rows.push({ name: p.name, model: p.model, total: 0, passed: 0, rate: 0, avg_sec: 0, tokens_in: 0, tokens_out: 0, cost: 0, error: '无报告产出' });
      continue;
    }
    const s = report.summary;
    const cost = (s.tokens.prompt / 1e6) * p.price_in + (s.tokens.completion / 1e6) * p.price_out;
    rows.push({
      name: p.name, model: p.model,
      total: s.total, passed: s.passed, errored: s.errored || 0,
      rate: s.unavailable ? '—' : s.success_rate,
      unavailable: !!s.unavailable,
      avg_sec: Math.round(s.duration_sec / Math.max(1, s.total)),
      tokens_in: s.tokens.prompt, tokens_out: s.tokens.completion,
      cost: s.unavailable ? '端点不可用' : Number(cost.toFixed(4)),
      by_category: s.by_category,
    });
  }

  const ts = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${Date.now().toString(36)}${process.pid}`;
  const md = [
    `# MJ Code Eval 对照报告（${ts}）`,
    '',
    `- 任务集：${path.basename(args.tasks)}（${rows[0]?.total || 0} 题）`,
    `- 成本口径：token × 单价（profiles.json 中 price_in/price_out，单位：元或美元/百万 token）`,
    '',
    '| 对照 | 模型 | 通过率 | 平均耗时 | 输入 token | 输出 token | 估算成本 |',
    '|------|------|--------|----------|-----------|-----------|----------|',
    ...rows.map((r) => `| ${r.name} | ${r.model} | ${r.unavailable ? `—（端点不可用 ${r.errored}/${r.total}）` : `${r.passed}/${r.total}（${r.rate}）`} | ${r.avg_sec}s | ${r.tokens_in} | ${r.tokens_out} | ${r.cost} |`),
    '',
    ...rows.filter((r) => r.by_category).map((r) => `- ${r.name} 分类：${Object.entries(r.by_category).map(([k, v]) => `${k} ${v}`).join(' ｜ ')}`),
  ].join('\n');
  const mdFile = path.join(RESULTS_DIR, `compare-report-${ts}.md`);
  const jsonFile = path.join(RESULTS_DIR, `compare-report-${ts}.json`);
  fs.writeFileSync(mdFile, md + '\n');
  fs.writeFileSync(jsonFile, JSON.stringify({ ts, tasks: args.tasks, rows }, null, 2));
  console.log(`\n对照报告：${mdFile}`);
}

main().catch((e) => { console.error('[compare] 执行失败:', e.message); process.exit(1); });

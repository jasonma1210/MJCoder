// P0-1: 窗口事实表「双份实现」一致性门禁（主进程 CJS ↔ 渲染层 TS）
//
// 为什么需要：渲染层不能 require 主进程 .js（打包/进程隔离），同一个表只能存在两份。
// 双份 = 必然漂移的温床（本项目已有前车之鉴：model 形状与 preload 桥面都漂移过）。
// 与 test/bridge-parity.test.mjs 同套路：用测试把「两处必须一致」变成可执行断言。
//
// 断言分两层：
//   1. 数据层：MODEL_WINDOWS / MODEL_FAMILIES / 常量 / PROVIDER_KINDS 深等；
//   2. 行为层：同一组入参下 resolveWindow 的三态返回值逐字段相等（覆盖 providerKind 判定、
//      modelId 归一化、族匹配、Ollama 探测分支）——只比数据不比行为会漏掉归一化逻辑的漂移。
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}
async function checkAsync(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

const MAIN = require('../main/modelWindows');
const TS_FILE = path.join(DESKTOP, 'renderer/src/lib/modelWindows.ts');

(async () => {
  // 渲染层 TS 模块：Node ≥22 默认启用类型剥离，可直接 import（与 tsc 的类型检查互补：
  // 这里验证的是「运行时数据与行为」，类型层由 npm run typecheck 负责）
  let RENDERER = null;
  let importErr = null;
  try {
    RENDERER = await import(TS_FILE);
  } catch (e) {
    importErr = e;
  }

  await checkAsync('渲染层 TS 版可被运行时加载', () => {
    if (!RENDERER) throw new Error(`import 失败（类型剥离不可用？）：${importErr?.message || '未知'}`);
  });

  check('主进程表模块零依赖（不得 require 任何模块）', () => {
    const src = fs.readFileSync(path.join(DESKTOP, 'main/modelWindows.js'), 'utf8');
    const requires = src.split('\n')
      .map((l, i) => ({ l, i: i + 1 }))
      .filter(({ l }) => /^\s*(const|let|var)\s+.*require\s*\(/.test(l) || /^\s*require\s*\(/.test(l));
    assert.deepEqual(requires.map(({ i }) => i), [], `main/modelWindows.js 出现 require（agent-core 零依赖纪律）`);
  });

  if (!RENDERER) {
    console.log(`\nmodel-windows-parity: ${pass}/${total} 通过（渲染层模块加载失败，数据层比对跳过）`);
    process.exit(1);
    return;
  }

  check('MODEL_WINDOWS 深等（键与窗口值逐条一致）', () => {
    assert.deepEqual(RENDERER.MODEL_WINDOWS, MAIN.MODEL_WINDOWS);
  });

  check('MODEL_FAMILIES 深等（族前缀与窗口一致）', () => {
    assert.deepEqual(RENDERER.MODEL_FAMILIES, MAIN.MODEL_FAMILIES);
  });

  check('常量与 providerKind 枚举深等', () => {
    assert.equal(RENDERER.DEFAULT_CONTEXT_WINDOW, MAIN.DEFAULT_CONTEXT_WINDOW);
    assert.equal(RENDERER.OLLAMA_UNKNOWN_NUM_CTX, MAIN.OLLAMA_UNKNOWN_NUM_CTX);
    assert.deepEqual(RENDERER.PROVIDER_KINDS, MAIN.PROVIDER_KINDS);
  });

  check('默认档已下调：表外未知模型 = 32768 且未确认', () => {
    assert.equal(MAIN.DEFAULT_CONTEXT_WINDOW, 32768);
    assert.deepEqual(MAIN.resolveWindow({ providerId: 'x', baseUrl: 'https://weird.example', modelId: 'weird' }),
      { window: 32768, confirmed: false, source: 'default' });
  });

  check('Ollama 禁止写死窗口：表内不得出现 ollama:* 键', () => {
    const ollamaKeys = Object.keys(MAIN.MODEL_WINDOWS).filter((k) => k.startsWith('ollama:'));
    assert.deepEqual(ollamaKeys, []);
    // 探测缺失 → 官方最小档 4096 + 未确认（高估=击穿，代价不对称）
    assert.deepEqual(MAIN.resolveWindow({ baseUrl: 'http://localhost:11434/v1', modelId: 'qwen3:8b' }),
      { window: 4096, confirmed: false, source: 'default' });
    // 探测成功 → 用 num_ctx 实际值
    assert.deepEqual(MAIN.resolveWindow({ baseUrl: 'http://localhost:11434/v1', modelId: 'qwen3:8b', probedNumCtx: 32768 }),
      { window: 32768, confirmed: true, source: 'ollama-probe' });
  });

  // ── 行为矩阵：两台实现必须对同一组入参给出完全相同的三态 ──
  const MATRIX = [
    { providerId: 'deepseek', modelId: 'deepseek-chat' },
    { providerId: 1, baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-chat' },
    { providerId: 1, baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-reasoner' },
    { providerId: 2, baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-4o' },
    { providerId: 2, baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-4.1' },
    { providerId: 2, baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-4.1-turbo-2025' },
    { providerId: 3, baseUrl: 'https://api.anthropic.com/v1', modelId: 'claude-sonnet-4-5-20250929' },
    { providerId: 4, baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com', modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0' },
    { providerId: 5, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: 'qwen3-32b' },
    { providerId: 5, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: 'qwen-max' },
    { providerId: 6, baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelId: 'models/gemini-2.5-pro' },
    { providerId: 7, baseUrl: 'http://localhost:11434/v1', modelId: 'qwen3:8b' },
    { providerId: 7, baseUrl: 'http://localhost:11434/v1', modelId: 'qwen3:8b', probedNumCtx: 32768 },
    { providerId: 8, baseUrl: 'https://api.moonshot.cn/v1', modelId: 'kimi-k2' },
    { providerId: 9, baseUrl: '', modelId: '' },
    { providerId: 'deepseek', modelId: 'DEEPSEEK-CHAT' },
    { providerId: 'anthropic', modelId: 'claude-opus-4-1' },
  ];

  check('resolveWindow 行为矩阵逐项一致（含 kind 判定 / 归一化 / 族匹配 / Ollama 分支）', () => {
    const diffs = [];
    for (const c of MATRIX) {
      const a = MAIN.resolveWindow(c);
      const b = RENDERER.resolveWindow(c);
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        diffs.push(`${JSON.stringify(c)} → main=${JSON.stringify(a)} renderer=${JSON.stringify(b)}`);
      }
    }
    assert.deepEqual(diffs, []);
  });

  // 四态：精确命中 / 同族推断 / 默认估算 / Ollama 探测。
  // family 是 2026-10-18 新增的一态——族规则（前缀匹配）会把没见过的版本号一起吞掉，
  // 不能算「已确认」（实测 deepseek-v4-* 被压成 128k，而真实窗口 ≥512k）。
  check('矩阵覆盖了四态（table / family / default / ollama-probe 都出现过）', () => {
    const sources = new Set(MATRIX.map((c) => MAIN.resolveWindow(c).source));
    assert.deepEqual([...sources].sort(), ['default', 'family', 'ollama-probe', 'table']);
  });

  check('同族推断不得冒充已确认（family ⇒ confirmed:false）', () => {
    for (const c of MATRIX) {
      const r = MAIN.resolveWindow(c);
      if (r.source === 'family') assert.equal(r.confirmed, false, JSON.stringify(c));
    }
    // 反向：精确命中必须仍是 confirmed:true（别把整张表都降级成估算）
    const exact = MAIN.resolveWindow({ providerId: 'deepseek', modelId: 'deepseek-chat' });
    assert.deepEqual(exact, { window: 131072, confirmed: true, source: 'table' });
    // 族规则命中的未登记版本：给窗口但标未确认
    const fam = MAIN.resolveWindow({ providerId: 'deepseek', modelId: 'deepseek-v4-flash' });
    assert.deepEqual(fam, { window: 131072, confirmed: false, source: 'family' });
  });

  console.log(`\nmodel-windows-parity: ${pass}/${total} 通过（表内 ${Object.keys(MAIN.MODEL_WINDOWS).length} 条精确项 / ${MAIN.MODEL_FAMILIES.length} 条族规则）`);
  if (pass !== total) process.exitCode = 1;
})();

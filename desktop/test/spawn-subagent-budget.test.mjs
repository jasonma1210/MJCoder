// spawn_subagent 预算专项测试（2026-10-15）
//
// 真机背景：用户报告「3 个 spawn_subagent 全部返回『预算耗尽』（0 token 即耗尽）」。
// 排查结论：子代理的 token 计数完全依赖 provider 回传的 usage——部分兼容端点的流式
// 响应不带 usage（stream_options 被忽略），于是 subTokens 恒 0：预算闸形同虚设、
// tokens_used 恒 0，上层看到「毫无消耗却停了」的假象；且轮次熔断与 token 熔断
// 混用同一个 budget_exhausted 字段，父代理无法区分失败模式，只会盲目重试同一目标。
//
// 本测试锁住三个修复：
//   ① usage 缺失时按内容长度估算，预算闸仍有效（不再恒 0）
//   ② budget_kind / rounds_exhausted / repeat_stopped / aborted 语义拆分
//   ③ 提前停止时回传可行动 hint（明确「不要原样重试」）
import { runAgent } from '../agent-core/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const model = {
  provider: { id: 1, isGlobal: false, base_url: 'https://api.example.com/v1' },
  model: { id: 1, model_id: 'test-chat', context_window: 128000 },
};

let chatScript = [];
function makeToolHandlers() {
  return {
    chat: async () => chatScript.shift() || { content: '（默认回复）', usage: { prompt_tokens: 5, completion_tokens: 3 } },
    readFile: async () => ({ content: 'file-content' }),
    listDir: async () => [],
    grep: async () => ({ matches: '' }),
    glob: async () => ({ files: [] }),
    gitStatus: async () => ({ stdout: '' }),
    gitDiff: async () => ({ stdout: '' }),
    gitLog: async () => ({ stdout: '' }),
    shell: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    writeFile: async () => ({ ok: true }),
    editFile: async () => ({ ok: true }),
    applyPatch: async () => ({ stdout: 'patched' }),
    mcpCallTool: async () => ({ content: [] }),
  };
}

// 父代理一轮：spawn_subagent(args) → 子代理跑完 → 父代理文本收尾
async function runParent(spawnArgs, subScript) {
  chatScript = [
    { content: '父代理派发', tool_calls: [{ id: 'p1', function: { name: 'spawn_subagent', arguments: JSON.stringify(spawnArgs) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } },
    ...subScript,
    { content: '父代理收尾', usage: { prompt_tokens: 100, completion_tokens: 20 } },
  ];
  let subResult = null;
  await runAgent({
    messages: [{ role: 'user', content: '派个子代理' }],
    model, cwd: '/tmp', maxRounds: 4,
    // V02 运行时白名单守卫（2026-10-16）：父代理须显式通告 spawn_subagent（原 tools:[] 旧语义已废除）
    tools: [{ type: 'function', function: { name: 'spawn_subagent', description: '派发只读子代理', parameters: { type: 'object', properties: {} } } }],
    toolHandlers: makeToolHandlers(),
    onMessage: () => {},
    onToolCall: (tc) => { if (tc.name === 'spawn_subagent') subResult = tc.result; },
  });
  return subResult;
}

(async () => {
  // ── ① provider 不回 usage：按内容长度估算，预算闸仍然有效 ──
  // 默认预算 50000；单轮回复 210,000 字符 ≈ 52,500 tokens（估算）→ 第 1 轮即超
  {
    const big = 'x'.repeat(210000);
    const sub = [];
    for (let i = 0; i < 8; i += 1) {
      sub.push({ content: big, tool_calls: [{ id: `s${i}`, function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] }); // 故意不带 usage
    }
    const r = await runParent({ objective: '大扫描' }, sub);
    check('usage 缺失时 tokens_used 不再恒 0（估算兜底）',
      typeof r?.tokens_used === 'number' && r.tokens_used > 0, `tokens_used=${r?.tokens_used}`);
    check('usage 缺失时预算闸仍会触发（budget_exhausted）',
      r?.budget_exhausted === true && r?.budget_kind === 'tokens', `kind=${r?.budget_kind}`);
    check('提前停止时回传 hint（明确不要原样重试）',
      typeof r?.hint === 'string' && r.hint.includes('不要用同一目标重试'), r?.hint?.slice(0, 60));
    check('子代理部分结论仍被返回（不是空结果）', String(r?.result || '').length > 0);
  }

  // ── ② 正常收尾：不再误报预算耗尽、无多余 hint ──
  {
    const r = await runParent({ objective: '找出入口文件' }, [
      { content: '子代理看文件', tool_calls: [{ id: 's1', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }], usage: { prompt_tokens: 50, completion_tokens: 10 } },
      { content: '子代理结论：入口在 index.js', usage: { prompt_tokens: 60, completion_tokens: 15 } },
    ]);
    check('正常收尾 budget_exhausted=false', r?.budget_exhausted === false, `kind=${r?.budget_kind}`);
    check('正常收尾无 hint（不噪音）', r?.hint === undefined);
    check('正常收尾 tokens_used 如实统计（>0）', (r?.tokens_used || 0) > 0, `used=${r?.tokens_used}`);
    check('正常收尾返回子代理结论', String(r?.result || '').includes('入口在 index.js'));
  }

  // ── ③ 显式 token_budget 生效，且与轮次熔断语义分离 ──
  {
    const sub = [];
    for (let i = 0; i < 6; i += 1) {
      sub.push({ content: `第 ${i} 轮`, tool_calls: [{ id: `s${i}`, function: { name: 'read_file', arguments: '{"path":"a.js"}' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
    }
    const r = await runParent({ objective: '大扫描', token_budget: 200 }, sub);
    check('显式 token_budget 生效（110/轮 → 2 轮超 200）',
      r?.budget_exhausted === true && r?.rounds_exhausted === false, `kind=${r?.budget_kind}, used=${r?.tokens_used}`);
    check('hint 指向「拆小目标或自己做」',
      typeof r?.hint === 'string' && (r.hint.includes('拆成更小') || r.hint.includes('自己做')));
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})();

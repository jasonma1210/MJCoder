// P1-10 角色模板工具裁剪闭环门禁（2026-10-18 全量修复）
//
// 缺口：`rolePreset.toolNames` 只裁**内置工具**，MCP 工具无条件附加——
//   「只读角色」照样能调任意写外部系统的 MCP 工具，角色隔离被整体绕过。
//
// 本套件锁三件事（缺一即不算闭环）：
//   ① allowMcp:false ⇒ 通告列表里 MCP 工具被裁掉；
//   ② 缺省 ⇒ **MCP 也走角色白名单**（B1-B-02 / F-019 语义翻转：缺省不再放宽；
//      存量数字员工的行为由 main/ecosystem.js buildEmployeeRuntimePreset 显式
//      `allowMcp: true` 保持不变——引擎侧收紧、角色构造层显式放开）；
//   ③ **只裁通告列表不算闭环**：模型硬调未通告的工具时，运行时白名单守卫必须拒绝，
//      且 handler 一次都不能被调用（fail-closed，不是「报了错但已经执行」）。
import {
  runAgent,
} from '../agent-core/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const mcpTools = [{
  type: 'function',
  function: { name: 'mcp__demo__ping', description: 'ping 外部系统', parameters: { type: 'object', properties: {} } },
}];
const model = {
  provider: { id: 1, isGlobal: false, base_url: 'http://local' },
  model: { id: 1, model_id: 'm', context_window: 200000 },
};

// 跑一次，返回「本轮实际通告的工具名」+ 工具调用结果 + handler 调用计数
async function runOnce({ rolePreset, forceCall }) {
  let advertised = [];
  let rounds = 0;
  const toolResults = [];
  let mcpCalls = 0;
  const toolHandlers = {
    chat: async (payload) => {
      const isMain = Array.isArray(payload.tools) && payload.tools.length > 0;
      if (!isMain) return { content: '【已完成】摘要', usage: { prompt_tokens: 20, completion_tokens: 5 } };
      rounds += 1;
      if (rounds === 1 && advertised.length === 0) {
        advertised = (payload.tools || []).map((t) => t.function?.name);
      }
      if (rounds === 1 && forceCall) {
        return {
          content: '我要调外部工具',
          tool_calls: [{ id: 'x1', type: 'function', function: { name: forceCall, arguments: '{"q":"1"}' } }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        };
      }
      return { content: '完成', usage: { prompt_tokens: 50, completion_tokens: 10 } };
    },
    readFile: async () => ({ content: 'file-body' }),
    mcpCallTool: async () => { mcpCalls += 1; return { ok: true, pong: true }; },
  };
  await runAgent({
    messages: [{ role: 'user', content: '只做只读的事' }],
    model,
    mcpTools,
    rolePreset,
    toolHandlers,
    tokenBudget: 0,
    maxRounds: 4,
    onMessage: () => {},
    onToolCall: (c) => toolResults.push({ name: c.name, result: c.result }),
  });
  return { advertised, toolResults, mcpCalls };
}

{
  // ① allowMcp:false ⇒ MCP 也被白名单收敛
  const strict = await runOnce({ rolePreset: { toolNames: ['read_file'], allowMcp: false } });
  check('allowMcp:false ⇒ 通告工具恰好 [read_file]',
    strict.advertised.length === 1 && strict.advertised[0] === 'read_file',
    `advertised=[${strict.advertised.join(',')}]`);

  // ② 缺省 ⇒ MCP 也走角色白名单（B1-B-02 / F-019：缺省值从 fail-open 翻为最小权限）
  // 旧断言是「缺省保持 MCP 全量」（advertised.length === 2）——那是最小权限闭包在 MCP 维度
  // 未生效（只读角色仍可调任意 MCP 写工具）。语义整体反转，原因见套件头注释 ②。
  const compat = await runOnce({ rolePreset: { toolNames: ['read_file'] } });
  check('缺省 allowMcp ⇒ 通告恰好 [read_file]（MCP 也走白名单，F-019 翻转）',
    compat.advertised.length === 1 && compat.advertised[0] === 'read_file',
    `advertised=[${compat.advertised.join(',')}]`);

  // ②b 存量兼容接缝：角色构造层显式 allowMcp:true ⇒ MCP 保留
  const explicit = await runOnce({ rolePreset: { toolNames: ['read_file'], allowMcp: true } });
  check('显式 allowMcp:true ⇒ 通告 [read_file, mcp__demo__ping]（存量数字员工行为不变）',
    explicit.advertised.length === 2
    && explicit.advertised.includes('read_file') && explicit.advertised.includes('mcp__demo__ping'),
    `advertised=[${explicit.advertised.join(',')}]`);

  // ③ 闭环：模型硬调未通告的 MCP 工具 → 守卫拒绝 + handler 未被调用
  const guarded = await runOnce({
    rolePreset: { toolNames: ['read_file'], allowMcp: false },
    forceCall: 'mcp__demo__ping',
  });
  const res = guarded.toolResults.find((r) => r.name === 'mcp__demo__ping')?.result || {};
  check('硬调未通告的 MCP 工具被运行时白名单守卫拒绝（notInAllowlist:true）',
    res.notInAllowlist === true, JSON.stringify(res).slice(0, 160));
  check('被拒绝的调用没有进入 handler（fail-closed，不是「报错但已执行」）',
    guarded.mcpCalls === 0, `mcpCallTool 调用 ${guarded.mcpCalls} 次`);
  check('拒绝文案指明 fail-closed 语义', String(res.error || '').includes('fail-closed'),
    String(res.error || '').slice(0, 100));

  // 对照：显式 allowMcp:true（存量兼容档）下同一调用必须被放行——证明上面的拒绝
  // 确实来自「角色裁剪」而非别的原因。对照组必须走**放开档**：新语义下缺省档本身也
  // 已被裁剪，若仍用缺省档做对照，对照组会与实验组同为拒绝，判据就失效了。
  const allowed = await runOnce({ rolePreset: { toolNames: ['read_file'], allowMcp: true }, forceCall: 'mcp__demo__ping' });
  const allowedRes = allowed.toolResults.find((r) => r.name === 'mcp__demo__ping')?.result || {};
  check('对照：显式 allowMcp:true 档下同一 MCP 调用被放行（证明拒绝来源是角色裁剪）',
    allowedRes.pong === true && allowed.mcpCalls === 1,
    `mcpCalls=${allowed.mcpCalls} result=${JSON.stringify(allowedRes).slice(0, 80)}`);
}

console.log(`\nrole-tool-cut: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);

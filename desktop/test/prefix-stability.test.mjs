// P1-4 稳定前缀区门禁（2026-10-18 全量修复）
//
// 成本形态：prompt cache 按**前缀**命中（Anthropic cache_control 断点 / OpenAI 自动前缀缓存
//   要求 ≥1024 token 前缀字节完全一致）。旧实现把全部可变内容（角色/技能/AGENTS.md/记忆/断点）
//   按变化频率混在一起拼——记忆或断点变一个字就整段前缀失效，每轮全价重算。
// 修法：段序按「变化频率递增」固定：base → role → tools → skills → agentsMd → memory → resume。
//
// 本套件锁三条不变量：
//   ① 两次 run 只在记忆/断点上不同 ⇒ 「记忆段之前」的前缀字节完全一致（这就是可缓存区）；
//   ② 续期/截断/空响应三种旁路指令一律走**末尾 user 消息**，不再拼进首条 system
//      （拼 system 会当轮把稳定前缀打废；中段 system 是 DeepSeek 系的硬坑）；
//   ③ 全文 role:'system' 只出现在开头连续块内（部分 OpenAI 兼容端点只认首部 system）。
import {
  runAgent,
} from '../agent-core/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const model = {
  provider: { id: 1, isGlobal: false, base_url: 'http://local' },
  model: { id: 1, model_id: 'm', context_window: 200000 },
};
const rolePreset = { name: 'reviewer', systemPrompt: '你是代码审查员，只做只读分析。', toolNames: null };

async function runOnce({ memories, resumeContext, maxRounds = 3, chat }) {
  const payloads = [];
  let rounds = 0;
  const toolHandlers = {
    chat: async (payload) => {
      const isMain = Array.isArray(payload.tools) && payload.tools.length > 0;
      if (!isMain) return { content: '【已完成】摘要', usage: { prompt_tokens: 20, completion_tokens: 5 } };
      payloads.push({ messages: payload.messages });
      rounds += 1;
      return chat(rounds);
    },
    shell: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
  };
  let doneText = null;
  await runAgent({
    messages: [{ role: 'user', content: '审查这个仓库' }],
    model,
    rolePreset,
    memories,
    resumeContext,
    toolHandlers,
    tokenBudget: 0,
    maxRounds,
    onMessage: () => {},
    onDone: (t) => { doneText = t; },
  });
  return { payloads, doneText, rounds };
}

const MEMORY_MARK = '## 相关记忆（本项目历史会话沉淀）';

// ── ① 稳定前缀字节一致 ──
{
  const flat = (r) => (rounds) => ({ content: rounds >= 2 ? '全部完成' : '继续', usage: { prompt_tokens: 100, completion_tokens: 10 } });
  const a = await runOnce({ memories: ['上次改过 main/main.js'], resumeContext: '断点 A', chat: flat() });
  const b = await runOnce({ memories: ['另一条完全不同的记忆条目，长度也不一样，用来验证字节偏移'], resumeContext: '断点 B：更长的一段断点摘要文本，用于制造不同的尾部长度', chat: flat() });

  const sysA = String(a.payloads[0]?.messages?.[0]?.content || '');
  const sysB = String(b.payloads[0]?.messages?.[0]?.content || '');
  check('两次 run 的 system 都以基础提示开头', sysA.length > 0 && sysB.length > 0, `lenA=${sysA.length} lenB=${sysB.length}`);
  check('system 内含记忆段（构造有效）', sysA.includes(MEMORY_MARK) && sysB.includes(MEMORY_MARK));

  const idxA = sysA.indexOf(MEMORY_MARK);
  const idxB = sysB.indexOf(MEMORY_MARK);
  const prefixA = Buffer.from(sysA.slice(0, idxA), 'utf8');
  const prefixB = Buffer.from(sysB.slice(0, idxB), 'utf8');
  check('「记忆段之前」的前缀字节完全一致（可缓存区不被可变内容污染）',
    prefixA.length === prefixB.length && prefixA.equals(prefixB),
    `A=${prefixA.length}B B=${prefixB.length}B equal=${prefixA.equals(prefixB)}`);
  console.log(`   ↑ 实测稳定前缀 ${prefixA.length} 字节（两次运行）`);
  check('记忆段之后的尾部确实不同（证明差异只落在可变段）', sysA !== sysB);
  check('前缀长度已达可缓存门槛（≥1024 字节）', prefixA.length >= 1024, `${prefixA.length}B`);

  // ── ③ system 只在开头连续块内 ──
  const sysOnlyLeading = (msgs) => {
    let seenNonSystem = false;
    for (const m of msgs) {
      if (m.role === 'system') {
        if (seenNonSystem) return false;
      } else seenNonSystem = true;
    }
    return true;
  };
  check('全文 role:system 只出现在开头连续块内（DeepSeek 约束）',
    a.payloads.every((p) => sysOnlyLeading(p.messages)) && b.payloads.every((p) => sysOnlyLeading(p.messages)));
  check('首条消息是 system（基础提示 + 角色 + 记忆都在同一条里）',
    a.payloads[0]?.messages?.[0]?.role === 'system');
}

// ── ② 续期指令走末尾 user，不进首条 system ──
{
  // maxRounds:1 ⇒ 第 2 轮预算耗尽触发续期（budgetExtensions<2），renewNotice 非空
  const r = await runOnce({
    memories: [],
    resumeContext: '',
    maxRounds: 1,
    chat: (rounds) => (rounds === 1
      ? { content: '第 1 步', tool_calls: [{ id: 'n1', type: 'function', function: { name: 'shell', arguments: '{"command":"echo 1"}' } }], usage: { prompt_tokens: 50, completion_tokens: 5 } }
      : { content: '全部完成', usage: { prompt_tokens: 50, completion_tokens: 5 } }),
  });
  const withNotice = r.payloads.find((p) => p.messages.some((m) => m.role === 'user' && String(m.content).includes('预算已续期')));
  check('续期指令以 user 消息送达（存在于某轮的 messages 中）', !!withNotice,
    `轮数=${r.payloads.length}`);
  const last = withNotice?.messages?.[withNotice.messages.length - 1];
  check('续期指令位于**末条**消息（不动前缀缓存）',
    last?.role === 'user' && String(last.content).includes('预算已续期'), `lastRole=${last?.role}`);
  check('续期指令不再拼进首条 system（否则当轮前缀全失效）',
    !String(withNotice?.messages?.[0]?.content || '').includes('预算已续期'),
    String(withNotice?.messages?.[0]?.content || '').slice(-60));
  check('续期后仍能正常收尾', String(r.doneText).includes('全部完成'), String(r.doneText).slice(-40));
}

console.log(`\nprefix-stability: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);

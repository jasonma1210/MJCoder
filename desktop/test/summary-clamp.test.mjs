// P2-3 摘要硬长度约束门禁（2026-10-18 全量修复）
//
// 问题：摘要提示里写了「300 字以内」，但返回值**零校验**——模型超写就直接进历史，
//   摘要本身变成新的大块上下文（紧窗口下每轮都压，越压越贵，形成正反馈）。
// 修法：clampSummary 在代码里截断，并把结构性摘要缺失的段落显式补齐
//   （「（模型未提供该段）」≠「该段没有内容」——模型必须能区分这两件事）。
import {
  compactHistory, clampSummary, COMPACT_SUMMARY_SECTIONS, COMPACT_SUMMARY_MAX_CHARS,
  estimateMessagesTokens, estimateTokens,
} from '../agent-core/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

check('COMPACT_SUMMARY_MAX_CHARS === 2000', COMPACT_SUMMARY_MAX_CHARS === 2000, `got=${COMPACT_SUMMARY_MAX_CHARS}`);
check('四段标记为【已完成】【关键发现】【待办】【约束】',
  COMPACT_SUMMARY_SECTIONS.join('') === '【已完成】【关键发现】【待办】【约束】',
  COMPACT_SUMMARY_SECTIONS.join(''));

// ── ① 纯函数：缺段补齐 ──
{
  const partial = clampSummary('【已完成】a');
  check('clampSummary 输入只有【已完成】时补齐其余三段',
    partial.includes('【已完成】a')
    && partial.includes('【关键发现】（模型未提供该段）')
    && partial.includes('【待办】（模型未提供该段）')
    && partial.includes('【约束】（模型未提供该段）'),
    JSON.stringify(partial));
  const long = clampSummary('x'.repeat(5000));
  check('超长摘要被硬截断并留 [摘要已截断] 标记',
    long.includes('[摘要已截断]') && long.length < 5000, `len=${long.length}`);
  const bodyLen = long.split('\n…[摘要已截断]')[0].length;
  check('截断点落在 max 处（正文不超过 2000 字符）', bodyLen === COMPACT_SUMMARY_MAX_CHARS, `bodyLen=${bodyLen}`);
  const full = clampSummary('【已完成】a\n【关键发现】b\n【待办】c\n【约束】d');
  check('四段齐全时原样返回（不画蛇添足）', !full.includes('（模型未提供该段）'), JSON.stringify(full));
}

// ── ② 压缩路径：模型返回 5000 字纯文本（无结构、超长）──
{
  const history = [{ role: 'system', content: 'SYS 你是 MJ Coder' }, { role: 'user', content: '开始审查仓库' }];
  for (let i = 0; i < 12; i += 1) {
    history.push({
      role: 'assistant', content: `第 ${i} 步`, tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: `echo ${i}` }) } }],
    });
    history.push({ role: 'tool', tool_call_id: `t${i}`, content: 'x'.repeat(300) });
  }
  const model = {
    provider: { id: 1, isGlobal: false, base_url: 'http://local' },
    model: { id: 1, model_id: 'm', context_window: 1000 },
  };
  const out = await compactHistory(history, model, async () => ({ content: 'y'.repeat(5000) }));
  const summary = out.find((m) => m.role === 'system' && String(m.content).includes('[早期对话摘要'));
  check('确实生成了摘要消息（压缩发生）', !!summary, `out=${out.length} 条`);
  const text = String(summary?.content || '');
  check('摘要消息含 [摘要已截断] 标记（模型超写被截断）', text.includes('[摘要已截断]'), `len=${text.length}`);
  check('四段标记全部出现（缺的段已补齐）',
    COMPACT_SUMMARY_SECTIONS.every((k) => text.includes(k)),
    COMPACT_SUMMARY_SECTIONS.filter((k) => !text.includes(k)).join(',') || '四段齐全');
  check('摘要整体体积远小于模型原始输出（5000 字符 → 受控）',
    estimateTokens(text) < estimateTokens('y'.repeat(5000)), `${estimateTokens(text)} tokens`);
  console.log(`   ↑ 实测摘要消息长度 ${text.length} 字符`);
  check('压缩结果仍有前导 system 与首条 user（固定头不丢）',
    out[0]?.role === 'system' && out.some((m) => m.role === 'user' && String(m.content).includes('开始审查仓库')));
  check('压缩结果体积确实下降', estimateMessagesTokens(out) < estimateMessagesTokens(history),
    `${estimateMessagesTokens(history)} → ${estimateMessagesTokens(out)}`);
}

console.log(`\nsummary-clamp: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);

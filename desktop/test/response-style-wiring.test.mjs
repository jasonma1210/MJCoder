// AI 描述粒度（设置 → 通用）接线门禁（2026-10-19）
//
// 缺陷形态：任务跑完后只回一行「运行结束」，没有任何核心结论（完成了什么 / 改了哪些文件 /
//   尚存问题 / 下一步）。修法是纯提示词工程——引擎在 system 里注入「任务收尾」产出规范，
//   档位（concise / default / detailed）只改收尾文案的详略，不做生成后改写。
//
// 本套件锁整条链：
//   ① 设置页三档入口 + 写 response_style（随 approvalSettings 一并持久化）；
//   ② agent-core RESPONSE_STYLE_SECTIONS 三档齐备 + PROMPT_SECTIONS 含 style 段；
//   ③ agentRunner engineParams 白名单放行 responseStyle（历史教训：漏了则真机全废）；
//   ④ useAgentRun 载荷携带 responseStyle；
//   ⑤ i18n 双语齐备；
//   ⑥ 行为验证：runAgent 真的按档在 system 里注入对应收尾指令，未知值回落 default。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from '../agent-core/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));

const settings = read('renderer/src/components/SettingsModal.jsx');
const agentRunner = read('main/agentRunner.js');
const useAgentRun = read('renderer/src/hooks/useAgentRun.ts');
const zh = readJson('renderer/src/i18n/locales/zh-CN/settings.json');
const en = readJson('renderer/src/i18n/locales/en-US/settings.json');

// ── ① 设置页入口 ───────────────────────────────
check('设置页声明三档常量（concise/default/detailed）',
  /RESPONSE_STYLES\s*=\s*\[[\s\S]*?id:\s*'concise'[\s\S]*?id:\s*'default'[\s\S]*?id:\s*'detailed'/.test(settings));
check('设置页遍历 RESPONSE_STYLES 渲染三档（不硬编码）', /RESPONSE_STYLES\.map\(/.test(settings));
check('选择档位时写回 approvalSettings.response_style',
  /onApprovalSettingsChange\?\.\(\{\s*\.\.\.approvalSettings,\s*response_style:\s*o\.id\s*\}\)/.test(settings));
check('缺省档为 default（与引擎默认档对齐）',
  /approvalSettings\?\.response_style\s*\|\|\s*'default'/.test(settings));

// ── ② 引擎段齐备 ───────────────────────────────
const core = read('agent-core/index.js');
check('agent-core 有 RESPONSE_STYLE_SECTIONS 三档',
  /RESPONSE_STYLE_SECTIONS\s*=\s*\{[\s\S]*?concise:[\s\S]*?default:[\s\S]*?detailed:/.test(core));
check('runAgent 接受 responseStyle 参数', /responseStyle\s*=\s*DEFAULT_RESPONSE_STYLE/.test(core));
check('未知值回落 default（白名单校验）',
  /hasOwnProperty\.call\(RESPONSE_STYLE_SECTIONS,\s*responseStyle\)/.test(core));
{
  // 收尾段并入 base，且必须排在 appendSystemPrompt **之前**——否则会破坏
  // append-system-prompt 门禁的「通道追加在 system 尾部」不变量。
  check('收尾段并入 base 装配（styleSection 进入 base）', core.includes('${styleSection}'));
  check('styleSection 排在 appendSystemPrompt 之前（通道追加仍居尾部）',
    core.includes('${styleSection}${appendSystemPrompt'));
}

// ── ③ 主进程白名单放行（最易漏的一环）───────────
check('agentRunner engineParams 放行 responseStyle',
  /responseStyle:\s*payload\.responseStyle\s*\|\|\s*undefined/.test(agentRunner),
  '缺这一环 ⇒ 单测全绿、真机无收尾（本文件历史教训）');

// ── ④ 渲染层载荷携带 ───────────────────────────
check('useAgentRun 载荷携带 responseStyle',
  /responseStyle:\s*approvalSettings\?\.response_style\s*\|\|\s*undefined/.test(useAgentRun));

// ── ⑤ i18n 双语齐备 ────────────────────────────
const KEYS = [
  'responseStyle', 'responseStyleDesc',
  'responseStyleConcise', 'responseStyleConciseDesc',
  'responseStyleDefault', 'responseStyleDefaultDesc',
  'responseStyleDetailed', 'responseStyleDetailedDesc',
];
const missingZh = KEYS.filter((k) => !(typeof zh[k] === 'string' && zh[k].length > 0));
const missingEn = KEYS.filter((k) => !(typeof en[k] === 'string' && en[k].length > 0));
check('zh-CN 八个 key 齐备', missingZh.length === 0, missingZh.join(',') || '全有');
check('en-US 八个 key 齐备', missingEn.length === 0, missingEn.join(',') || '全有');

// ── ⑥ 行为验证：档位真的改变 system ─────────────
const model = {
  provider: { id: 1, isGlobal: false, base_url: 'https://api.example.com/v1' },
  model: { id: 1, model_id: 'm', context_window: 128000 },
};

async function systemPromptOf(extra = {}) {
  let system = '';
  await runAgent({
    messages: [{ role: 'user', content: '你好' }],
    model,
    maxRounds: 1,
    toolHandlers: {
      chat: async (payload) => {
        system = String((payload.messages || []).find((m) => m.role === 'system')?.content || '');
        return { content: '好的', usage: { prompt_tokens: 1, completion_tokens: 1 } };
      },
    },
    onMessage: () => {},
    onDone: () => {},
    ...extra,
  });
  return system;
}

const MARK = { concise: '## 任务收尾（精简）', default: '## 任务收尾（默认）', detailed: '## 任务收尾（详细）' };
for (const style of ['concise', 'default', 'detailed']) {
  const sys = await systemPromptOf({ responseStyle: style });
  check(`responseStyle=${style} → system 注入「${MARK[style]}」`, sys.includes(MARK[style]));
  // 隔离：只注入被选中的那一档（避免三档文本互相污染）
  const others = Object.entries(MARK).filter(([k]) => k !== style);
  check(`responseStyle=${style} → 不混入其他档文案`,
    others.every(([, mk]) => !sys.includes(mk)));
}
{
  const def = await systemPromptOf();
  check('未传 responseStyle → 回落 default 档', def.includes(MARK.default));
  const bad = await systemPromptOf({ responseStyle: 'whatever' });
  check('未知 responseStyle → 回落 default 档（不放大不缩小）', bad.includes(MARK.default));
}
check('收尾段仍位于稳定前缀内（base 之后，记忆段之前）',
  (await systemPromptOf({ responseStyle: 'default', memories: ['一条记忆'] }))
    .indexOf(MARK.default) < (await systemPromptOf({ responseStyle: 'default', memories: ['一条记忆'] })).indexOf('## 相关记忆'));

console.log(`\nresponse-style-wiring: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;

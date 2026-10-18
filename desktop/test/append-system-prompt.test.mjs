// 追加① 回归门禁：通道级系统提示必须是**追加**，不能整体替换 BASE_PROMPT
//
// 事故：定时通道传的是 systemPrompt（agent-core 里是 `customSystemPrompt || BASE_PROMPT` 的
// **整体替换**语义），于是 BASE_PROMPT 里「你会用 write_file / read_file、默认在当前目录读写、
// 路径怎么给」这些能力说明全被丢掉。模型连自己在哪个目录、能不能写文件都不知道 ——
// 真机表现就是 5 次工具调用、0 次写文件、最后只回一段文本。
//
// 本文件钉：appendSystemPrompt 拼在 BASE_PROMPT 之后（BASE_PROMPT 仍是完整前缀，prompt cache 不受影响），
// 并顺手断言「替换语义确实会丢 BASE_PROMPT」——把事故原因变成可复现的机器事实。
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { runAgent } = await import('../agent-core/index.js');
const { buildScheduledPrompt } = require(path.join(ROOT, 'main', 'scheduledOutput.js'));

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); fail++; }
}

// BASE_PROMPT 的身份句（稳定锚点）：它出现 = BASE_PROMPT 还在
const BASE_MARK = '你是 MJ Coder';
const model = {
  provider: { id: 1, isGlobal: false, base_url: 'https://api.deepseek.com/v1' },
  model: { id: 1, model_id: 'deepseek-chat', context_window: 128000 },
};

async function systemPromptOf(params) {
  let system = '';
  let seen = 0;
  await runAgent({
    messages: [{ role: 'user', content: '你好' }],
    model,
    toolHandlers: {
      chat: async (payload) => {
        seen += 1;
        system = String((payload.messages || []).find((m) => m.role === 'system')?.content || '');
        return { content: '好的', usage: { prompt_tokens: 1, completion_tokens: 1 } };
      },
    },
    ...params,
  });
  assert.ok(seen > 0, '模型没有被调用（用例前提不成立）');
  return system;
}

await check('不传任何通道提示时：system 就是 BASE_PROMPT', async () => {
  const s = await systemPromptOf({});
  assert.ok(s.startsWith(BASE_MARK), `system 里没有 BASE_PROMPT：${s.slice(0, 80)}`);
});

await check('appendSystemPrompt：BASE_PROMPT 保留，通道契约追加在末尾', async () => {
  const s = await systemPromptOf({ appendSystemPrompt: '## 通道契约\n只回一句汇总。' });
  assert.ok(s.startsWith(BASE_MARK), 'BASE_PROMPT 被丢掉了（又变回整体替换）');
  assert.ok(s.includes('## 通道契约'), '追加内容没进去');
  assert.ok(s.indexOf('## 通道契约') > s.indexOf(BASE_MARK), '追加内容位置不对（应在 BASE_PROMPT 之后）');
  assert.ok(s.trimEnd().endsWith('只回一句汇总。'), '追加内容不在末尾（会污染 BASE_PROMPT 的前缀缓存）');
});

await check('反证：systemPrompt（替换语义）会整段丢掉 BASE_PROMPT —— 这就是事故原因', async () => {
  const s = await systemPromptOf({ systemPrompt: '你是定时任务执行器：产出精炼摘要。' });
  assert.ok(!s.includes(BASE_MARK), '替换语义没有生效？那本文件的结论需要重新评估');
  assert.ok(s.startsWith('你是定时任务执行器'), s.slice(0, 40));
});

await check('集成：定时通道的产出契约作为追加后，系统提示同时含 BASE_PROMPT 与产出目录', async () => {
  const dir = '/Users/x/Documents/.MJCoder/output/娱乐八卦';
  const s = await systemPromptOf({ appendSystemPrompt: buildScheduledPrompt({ dir, contextCwd: '/proj/x' }) });
  assert.ok(s.startsWith(BASE_MARK));
  assert.ok(s.includes(dir), '产出目录没进系统提示');
  assert.match(s, /必须把产物写成文件/);
  // 能力说明（BASE_PROMPT 里的工具约定）必须还在：模型得知道自己能写文件
  assert.match(s, /write_file|写入文件|写文件/);
});

console.log(`\nappend-system-prompt: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);

// 任务执行器：以任务 prompt 调用服务端模型（chat 代理同链路），返回文本结果
// 说明：M2 阶段为「模型直连」执行——本地工具（shell/文件）的执行需要桌面端 Agent 在场，
// 将在后续里程碑以「桌面端认领」机制接入；此处结果仍持久化并可查看。
const db = require('../db');
const { decrypt } = require('../lib/crypto');

const DEFAULT_MODEL = process.env.SCHEDULER_MODEL || 'deepseek-chat';

// 解析任务使用的模型凭证：优先线程快照的 provider，回落首个可用全局/私有 provider
async function resolveProvider(task, userId) {
  if (task.thread_id) {
    const t = await db.query(
      `SELECT th.provider_id, th.model_name, p.base_url, p.api_key, p.id AS pid
       FROM threads th LEFT JOIN model_providers p ON th.provider_id = p.id
       WHERE th.id = $1`,
      [task.thread_id]
    );
    if (t.rows.length > 0 && t.rows[0].base_url) {
      return { base_url: t.rows[0].base_url, api_key: decrypt(t.rows[0].api_key), model: t.rows[0].model_name || DEFAULT_MODEL };
    }
  }
  const g = await db.query(
    'SELECT base_url, api_key FROM global_providers WHERE is_active = true ORDER BY sort_order LIMIT 1'
  );
  if (g.rows.length > 0) {
    return { base_url: g.rows[0].base_url, api_key: decrypt(g.rows[0].api_key), model: DEFAULT_MODEL };
  }
  const p = await db.query(
    'SELECT base_url, api_key FROM model_providers WHERE user_id = $1 AND is_active = true LIMIT 1',
    [userId]
  );
  if (p.rows.length > 0) {
    return { base_url: p.rows[0].base_url, api_key: decrypt(p.rows[0].api_key), model: DEFAULT_MODEL };
  }
  throw new Error('未配置可用模型：请先配置全局或私有模型服务');
}

async function runTaskPrompt(task) {
  const provider = await resolveProvider(task, task.user_id);
  if (!provider.api_key) throw new Error('模型凭证为空');

  const messages = [
    { role: 'system', content: '你是 MJ Coder 的定时任务执行器。按用户指令直接产出结果，简洁明了，使用简体中文。' },
    { role: 'user', content: String(task.prompt || '').slice(0, 20000) },
  ];

  const res = await fetch(`${String(provider.base_url).replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.api_key}` },
    body: JSON.stringify({ model: provider.model, messages, stream: false }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`模型调用失败 ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  if (!content) throw new Error('模型返回空结果');
  return content;
}

module.exports = { runTaskPrompt, resolveProvider };

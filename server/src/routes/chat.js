const express = require('express');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { decrypt } = require('../lib/crypto');
const { assertSafeUpstream } = require('../lib/urlGuard');
const router = express.Router();
router.use(authMiddleware);

// 服务端模型代理：桌面端主进程的兜底路径（默认走主进程直连，此路径供离线异常回退与后续计费埋点）
// body: { providerId, isGlobal, messages, model, tools, stream }
router.post('/chat', async (req, res) => {
  const { providerId, isGlobal = false, messages, model, tools, stream = true } = req.body;
  if (!providerId || !messages || !model) {
    return res.status(400).json({ error: 'providerId, messages, model required' });
  }
  try {
    const table = isGlobal ? 'global_providers' : 'model_providers';
    const where = isGlobal ? 'id = $1 AND is_active = true' : 'id = $1 AND user_id = $2 AND is_active = true';
    const params = isGlobal ? [providerId] : [providerId, req.userId];
    const r = await db.query(`SELECT id, name, base_url, api_key FROM ${table} WHERE ${where}`, params);
    if (r.rows.length === 0) {
      return res.status(404).json({ error: 'Provider not found' });
    }
    const provider = r.rows[0];
    const apiKey = decrypt(provider.api_key);
    if (!apiKey) {
      return res.status(400).json({ error: 'PROVIDER_KEY_MISSING' });
    }
    const baseUrl = String(provider.base_url).replace(/\/+$/, '');
    // base_url 由用户填写，直接 fetch 会让本代理变成内网/云元数据的跳板，先做协议与网段校验
    let upstreamUrl;
    try {
      upstreamUrl = await assertSafeUpstream(`${baseUrl}/chat/completions`);
    } catch (e) {
      return res.status(400).json({ error: '上游地址不被允许：' + e.message });
    }
    const body = { model, messages, stream, stream_options: { include_usage: true } };
    if (tools) body.tools = tools;

    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!upstream.ok) {
      const errText = await upstream.text();
      // 上游错误体可能含内部信息（路由、上游密钥提示、调试栈），只落服务端日志，不回传客户端
      console.warn(`[chat] upstream ${upstream.status} ${upstreamUrl.host}: ${errText.slice(0, 500)}`);
      let upstreamCode;
      try {
        const parsed = JSON.parse(errText);
        upstreamCode = parsed?.error?.code || parsed?.error?.type;
      } catch {
        // 非 JSON 错误体，忽略
      }
      const payload = { error: `Upstream ${upstream.status}` };
      if (upstreamCode) payload.upstreamCode = upstreamCode;
      return res.status(upstream.status).json(payload);
    }
    if (!stream) {
      return res.json(await upstream.json());
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  }
});

module.exports = router;

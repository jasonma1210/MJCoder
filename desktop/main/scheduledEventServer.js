'use strict';
// 定时任务的**事件入口**（本地回环 HTTP）。
//
// 为什么要一个 HTTP 端点：事件触发的价值在于「别人能推给我」。没有入口时，
// trigger_type='event' 的任务永远不可能被触发，等于配置项是死的。
//
// 安全取向（本地优先产品不能开一个裸端口）：
//   · 只绑 127.0.0.1，绝不 0.0.0.0；
//   · 必须带 token（`x-mj-token`）；token 未配置时自动生成并打到控制台；
//   · 必须显式给端口（MJ_SCHEDULED_EVENT_PORT）才启动 —— 默认不监听，装完不会莫名多一个端口；
//   · 请求体上限 64KB，只认 POST /event。
//
// 自测：MJ_SCHEDULED_EVENT_PORT=47615 MJ_SCHEDULED_EVENT_TOKEN=dev npm start
//       curl -s -XPOST 127.0.0.1:47615/event -H 'x-mj-token: dev' \
//         -d '{"source":"github","event":"pr_opened","id":"pr-42"}'
const http = require('node:http');
const crypto = require('node:crypto');

const MAX_BODY = 64 * 1024;

function createScheduledEventServer({ ingest, env = process.env, log = console.log } = {}) {
  const port = Number(env.MJ_SCHEDULED_EVENT_PORT) || 0;
  const token = String(env.MJ_SCHEDULED_EVENT_TOKEN || '').trim() || crypto.randomBytes(12).toString('hex');
  let server = null;

  function start() {
    if (!port) return { ok: false, reason: 'disabled' };
    if (typeof ingest !== 'function') return { ok: false, reason: 'no_ingest' };
    server = http.createServer((req, res) => {
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method !== 'POST' || req.url !== '/event') return send(404, { ok: false, error: 'not_found' });
      if (String(req.headers['x-mj-token'] || '') !== token) return send(401, { ok: false, error: 'bad_token' });
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { send(413, { ok: false, error: 'payload_too_large' }); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', async () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
        catch { return send(400, { ok: false, error: 'invalid_json' }); }
        try {
          const r = await ingest(body);
          return send(200, r);
        } catch (e) {
          return send(500, { ok: false, error: String(e?.message || e) });
        }
      });
      return undefined;
    });
    server.on('error', (e) => console.warn('[scheduled] 事件端口启动失败（不影响定时任务）:', e.message));
    // 只绑回环：任何情况下都不对外暴露
    server.listen(port, '127.0.0.1', () => {
      log(`[scheduled] 事件入口已监听 127.0.0.1:${port}（POST /event，token=${token}）`);
    });
    return { ok: true, port, token };
  }

  function stop() {
    try { server?.close(); } catch { /* 关闭失败无副作用 */ }
    server = null;
  }

  return { start, stop, port, token };
}

module.exports = { createScheduledEventServer, MAX_BODY };

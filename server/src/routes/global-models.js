const express = require('express');
const db = require('../db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { decrypt } = require('../lib/crypto');
const router = express.Router();

// 公开接口：列出服务器端预设模型（无需认证，不含 api_key）
router.get('/global/providers', async (req, res) => {
  try {
    const providers = await db.query(
      'SELECT id, name, base_url, wire_api, sort_order FROM global_providers WHERE is_active = true ORDER BY sort_order'
    );
    const result = [];
    for (const p of providers.rows) {
      const models = await db.query(
        'SELECT id, model_id, display_name, context_window, max_output, is_recommended FROM global_models WHERE provider_id = $1',
        [p.id]
      );
      result.push({ ...p, models: models.rows });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 认证接口：主进程专用——返回解密后的 api_key（严禁暴露给渲染层）
router.get('/global/providers/secrets', authMiddleware, async (req, res) => {
  try {
    const providers = await db.query(
      'SELECT id, name, base_url, wire_api, api_key FROM global_providers WHERE is_active = true ORDER BY sort_order'
    );
    res.json(providers.rows.map(p => ({
      id: p.id,
      name: p.name,
      base_url: p.base_url,
      wire_api: p.wire_api,
      api_key: decrypt(p.api_key) || '',
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin 接口：逐路由显式挂载（禁用 router.use 兜底，否则会吞掉其他 router 的未匹配路径）
router.post('/admin/global/providers', authMiddleware, requireAdmin, async (req, res) => {
  const { name, base_url, api_key, wire_api = 'chat' } = req.body;
  try {
    const result = await db.query(
      'INSERT INTO global_providers (name, base_url, api_key, wire_api) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, base_url, api_key, wire_api]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/global/providers/:id/models', authMiddleware, requireAdmin, async (req, res) => {
  const { model_id, display_name, context_window, max_output, is_recommended } = req.body;
  try {
    const result = await db.query(
      'INSERT INTO global_models (provider_id, model_id, display_name, context_window, max_output, is_recommended) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [req.params.id, model_id, display_name || model_id, context_window || 128000, max_output || 4096, is_recommended || false]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;

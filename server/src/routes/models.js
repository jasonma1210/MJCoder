const express = require('express');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { encrypt, decrypt } = require('../lib/crypto');
const router = express.Router();
router.use(authMiddleware);

// 主进程专用：返回当前用户私有 provider 的解密 api_key（严禁暴露给渲染层）
router.get('/providers/secrets', async (req, res) => {
  try {
    const providers = await db.query(
      'SELECT id, name, base_url, wire_api, api_key FROM model_providers WHERE user_id = $1 AND is_active = true',
      [req.userId]
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

// List all providers + their models
router.get('/providers', async (req, res) => {
  try {
    const providers = await db.query(
      'SELECT id, name, provider_type, base_url, wire_api, is_active, created_at FROM model_providers WHERE user_id = $1',
      [req.userId]
    );
    const result = [];
    for (const p of providers.rows) {
      const models = await db.query(
        'SELECT id, model_id, display_name, context_window, max_output, supports_streaming, is_default FROM models WHERE provider_id = $1',
        [p.id]
      );
      result.push({ ...p, models: models.rows });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add provider
router.post('/providers', async (req, res) => {
  const { name, base_url, api_key, wire_api = 'chat' } = req.body;
  try {
    const result = await db.query(
      'INSERT INTO model_providers (user_id, name, base_url, api_key, wire_api) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, base_url, wire_api, is_active',
      [req.userId, name, base_url, encrypt(api_key), wire_api]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update provider
router.put('/providers/:id', async (req, res) => {
  const { name, base_url, api_key, wire_api, is_active } = req.body;
  try {
    const result = await db.query(
      'UPDATE model_providers SET name=COALESCE($1,name), base_url=COALESCE($2,base_url), api_key=COALESCE($3,api_key), wire_api=COALESCE($4,wire_api), is_active=COALESCE($5,is_active) WHERE id=$6 AND user_id=$7 RETURNING *',
      [name, base_url, encrypt(api_key), wire_api, is_active, req.params.id, req.userId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete provider
router.delete('/providers/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM model_providers WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add model to provider
router.post('/providers/:id/models', async (req, res) => {
  const { model_id, display_name, context_window = 128000, max_output = 4096 } = req.body;
  try {
    const result = await db.query(
      'INSERT INTO models (provider_id, model_id, display_name, context_window, max_output) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.params.id, model_id, display_name || model_id, context_window, max_output]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete model
router.delete('/models/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM models WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user preferences
router.get('/preferences', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM user_preferences WHERE user_id = $1', [req.userId]);
    res.json(result.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update preferences
router.put('/preferences', async (req, res) => {
  const { theme, custom_colors, default_model_id, sidebar_collapsed, font_size } = req.body;
  try {
    const result = await db.query(
      `INSERT INTO user_preferences (user_id, theme, custom_colors, default_model_id, sidebar_collapsed, font_size)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET theme=COALESCE($2,theme), custom_colors=COALESCE($3,custom_colors), default_model_id=COALESCE($4,default_model_id), sidebar_collapsed=COALESCE($5,sidebar_collapsed), font_size=COALESCE($6,font_size), updated_at=NOW()
       RETURNING *`,
      [req.userId, theme, JSON.stringify(custom_colors || null), default_model_id, sidebar_collapsed, font_size]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

const express = require('express');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Dashboard stats
router.get('/dashboard', async (req, res) => {
  const userId = req.userId;
  try {
    const [threads, messages, tokens, modelDist, recentActivity, weeklyThreads] = await Promise.all([
      // Total threads
      db.query('SELECT count(*) as count FROM threads WHERE user_id = $1 AND archived = false', [userId]),
      // Total messages
      db.query('SELECT count(*) as count FROM messages m JOIN threads t ON m.thread_id = t.id WHERE t.user_id = $1', [userId]),
      // Total tokens
      db.query('SELECT COALESCE(sum(tokens_input),0) as input, COALESCE(sum(tokens_output),0) as output FROM messages m JOIN threads t ON m.thread_id = t.id WHERE t.user_id = $1', [userId]),
      // Model usage distribution
      db.query(`
        SELECT m.model_name, count(*) as msg_count, sum(m.tokens_input + m.tokens_output) as tokens
        FROM messages m JOIN threads t ON m.thread_id = t.id
        WHERE t.user_id = $1 AND m.model_name IS NOT NULL
        GROUP BY m.model_name ORDER BY tokens DESC NULLS LAST
      `, [userId]),
      // Recent 7 days activity（列名限定 m.created_at，避免与 threads.created_at 歧义）
      db.query(`
        SELECT date_trunc('day', m.created_at) as day, count(*) as count
        FROM messages m JOIN threads t ON m.thread_id = t.id
        WHERE t.user_id = $1 AND m.created_at > NOW() - INTERVAL '7 days'
        GROUP BY day ORDER BY day
      `, [userId]),
      // Threads created per week
      db.query(`
        SELECT date_trunc('week', created_at) as week, count(*) as count
        FROM threads WHERE user_id = $1 AND archived = false
        GROUP BY week ORDER BY week DESC LIMIT 8
      `, [userId]),
    ]);

    res.json({
      threads: parseInt(threads.rows[0].count),
      messages: parseInt(messages.rows[0].count),
      tokens_input: parseInt(tokens.rows[0].input),
      tokens_output: parseInt(tokens.rows[0].output),
      model_distribution: modelDist.rows.map(r => ({
        model: r.model_name,
        messages: parseInt(r.msg_count),
        tokens: parseInt(r.tokens || 0),
      })),
      recent_activity: recentActivity.rows.map(r => ({
        day: r.day.toISOString().slice(0, 10),
        count: parseInt(r.count),
      })),
      weekly_threads: weeklyThreads.rows.map(r => ({
        week: r.week.toISOString().slice(0, 10),
        count: parseInt(r.count),
      })),
    });
  } catch (err) {
    console.error('[dashboard] 统计失败:', err);
    res.status(500).json({ error: '统计数据加载失败' });
  }
});

module.exports = router;

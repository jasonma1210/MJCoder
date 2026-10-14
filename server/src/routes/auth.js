const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { features } = require('../config/features');
// M6 鉴权统一：复用共享中间件，不再在路由内维护第二份实现
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

// ── 小程序绑定（M5 控制面；M6 起默认停用，需 MJ_MINIPROGRAM_ENABLED=1）──
// bindCode 内存态（10 分钟有效）；生产环境 openid 换取需配置 WX_APPID/WX_APPSECRET 走 code2session
const mpBindCodes = new Map(); // bindCode -> { openid, createdAt }
const mpBindings = new Map();  // openid -> userId

// 小程序控制面开关闸门：停用时统一 503，关闭绑定攻击面
function requireMiniprogram(req, res, next) {
  if (!features.miniprogram) {
    return res.status(503).json({ error: '小程序控制面已停用（M6 暂停），如需恢复设置 MJ_MINIPROGRAM_ENABLED=1' });
  }
  next();
}

router.post('/mp-bind', requireMiniprogram, async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code required' });
  let openid = `mp-${Buffer.from(code).toString('base64url').slice(0, 24)}`;
  // 配置了微信密钥时走真实 code2session
  if (process.env.WX_APPID && process.env.WX_APPSECRET) {
    try {
      const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${process.env.WX_APPID}&secret=${process.env.WX_APPSECRET}&js_code=${code}&grant_type=authorization_code`;
      const r = await fetch(url);
      const data = await r.json();
      if (data.openid) openid = data.openid;
      else return res.status(401).json({ error: `微信登录失败: ${data.errmsg || 'code 无效'}` });
    } catch (err) {
      return res.status(502).json({ error: '微信服务不可达' });
    }
  }
  const bindCode = Math.random().toString(36).slice(2, 10).toUpperCase();
  mpBindCodes.set(bindCode, { openid, createdAt: Date.now() });
  // 临时 mpToken（15min，绑定待确认态）——小程序后续查询凭此识别自身
  const mpToken = jwt.sign({ openid, scope: 'mp-pending' }, process.env.JWT_SECRET, { expiresIn: '15m' });
  res.json({ bindCode, mpToken, expiresIn: 600 });
});

// 桌面端（已登录 JWT）确认绑定：bindCode 关联当前账户
router.post('/mp-confirm', requireMiniprogram, authMiddleware, async (req, res) => {
  const { bindCode } = req.body || {};
  const entry = mpBindCodes.get(String(bindCode || '').toUpperCase());
  if (!entry || Date.now() - entry.createdAt > 10 * 60 * 1000) {
    return res.status(400).json({ error: '绑定码无效或已过期' });
  }
  mpBindCodes.delete(bindCode);
  mpBindings.set(entry.openid, req.userId);
  res.json({ ok: true });
});

// 小程序凭临时 mpToken 查询绑定状态：桌面确认后签发正式小程序 JWT（7 天）
router.get('/mp-session', requireMiniprogram, async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'mpToken required' });
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'mpToken 无效或已过期，请重新登录绑定' });
  }
  if (payload.scope !== 'mp-pending') return res.status(403).json({ error: '非绑定查询凭证' });
  const userId = mpBindings.get(payload.openid);
  if (!userId) return res.status(404).json({ error: '桌面端尚未确认绑定' });
  const mpJwt = jwt.sign({ userId, openid: payload.openid, scope: 'mp' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token: mpJwt });
});

// Register
router.post('/register', async (req, res) => {
  const { email, username, password } = req.body;
  if (!email || !username || !password) {
    return res.status(400).json({ error: 'email, username, password required' });
  }
  try {
    const exists = await db.query('SELECT id FROM users WHERE email = $1 OR username = $2', [email, username]);
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: 'Email or username already exists' });
    }
    const hash = await bcrypt.hash(password, 10);
    // 管理员授权：仅 ADMIN_EMAILS 环境变量匹配的邮箱（逗号分隔）
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const role = adminEmails.includes(String(email).toLowerCase()) ? 'admin' : 'user';
    const result = await db.query(
      'INSERT INTO users (email, username, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, email, username, role',
      [email, username, hash, role]
    );
    const user = result.rows[0];
    // Create default preferences
    await db.query('INSERT INTO user_preferences (user_id) VALUES ($1)', [user.id]);
    const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES });
    res.json({ token, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await db.query('SELECT id, email, username, password_hash, role FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES });
    res.json({ token, user: { id: user.id, email: user.email, username: user.username, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

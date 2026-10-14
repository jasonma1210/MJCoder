const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const PREFIX = 'v1:';

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  const buf = Buffer.from(raw, 'hex');
  if (buf.length !== 32) {
    throw new Error('ENCRYPTION_KEY 必须是 32 字节 hex（64 字符）。生成：openssl rand -hex 32');
  }
  return buf;
}

// 加密凭证；无密钥时回落明文并警告（不静默）
function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return plain;
  const key = getKey();
  if (!key) {
    console.warn('[crypto] 未设置 ENCRYPTION_KEY，api_key 将以明文存储');
    return plain;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

// 解密凭证；兼容旧明文（无 v1: 前缀原样返回）
function decrypt(stored) {
  if (!stored || !stored.startsWith(PREFIX)) return stored;
  const key = getKey();
  if (!key) {
    throw new Error('已存储的加密凭证需要 ENCRYPTION_KEY 才能解密，请检查环境变量');
  }
  const parts = stored.split(':');
  if (parts.length !== 4) throw new Error('加密凭证格式损坏');
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(parts[1], 'hex'));
  decipher.setAuthTag(Buffer.from(parts[2], 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(parts[3], 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

module.exports = { encrypt, decrypt };

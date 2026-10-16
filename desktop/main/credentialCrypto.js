// 凭证加密双轨（P0-D 本地凭证安全 + 打包版 safeStorage 不可用降级）
// 背景：2026-10-14 打包版（macOS 27 + 开发者签名非 MAS）真机上 safeStorage.isEncryptionAvailable()
// 返回 false，凭证保存被硬拒绝 → 自定义模型服务无法配置。
// 双轨设计：
//   轨 1 safeStorage（首选）：OS 钥匙串托管密钥，密文 = base64（无前缀）
//   轨 2 file-key（降级）：本地随机 32B 密钥落 userData/credential.key（0600），
//         AES-256-GCM 加密，密文带 'v2:' 前缀；保护级别从「OS 钥匙串」降至「文件权限」，
//         与 local-data.json 同目录同级风险（数据本就本地优先），可接受并显式留痕 console.warn。
// 解密按前缀自动路由：'v2:' → 轨 2；否则 → 轨 1（旧 safeStorage 密文兼容）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PREFIX = 'v2:';

class CredentialCrypto {
  // safeStorage 可为 undefined（纯 Node 测试环境 / Electron API 缺失）→ 自动走轨 2
  constructor(userDataDir, safeStorage) {
    this.userDataDir = userDataDir;
    this.safeStorage = safeStorage;
    this._fileKey = null;
  }

  _keyFile() { return path.join(this.userDataDir, 'credential.key'); }

  _loadFileKey() {
    if (this._fileKey) return this._fileKey;
    try {
      const saved = fs.readFileSync(this._keyFile(), 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(saved)) { this._fileKey = saved; return this._fileKey; }
    } catch { /* 首次运行无密钥文件 */ }
    this._fileKey = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(this.userDataDir, { recursive: true });
    fs.writeFileSync(this._keyFile(), this._fileKey + '\n', { mode: 0o600 });
    try { fs.chmodSync(this._keyFile(), 0o600); } catch (e) {
      // P0-16 修复（2026-10-16）：原为纯空吞。Windows 上 chmod 受限语义失败时，
      // 密钥文件以默认权限暴露——这是所有 provider 凭证密文的解密钥匙，
      // 权限失效必须显式留痕，否则用户无从得知。
      console.error(`[credential] 密钥文件权限收紧失败（0600 未生效，密钥文件可能被同机其他账户读取）: ${e.message}`);
    }
    return this._fileKey;
  }

  get scheme() {
    try { if (this.safeStorage?.isEncryptionAvailable?.()) return 'safeStorage'; } catch { /* 探测失败按不可用 */ }
    return 'file-key';
  }

  encrypt(plain) {
    if (this.scheme === 'safeStorage') {
      return this.safeStorage.encryptString(String(plain)).toString('base64');
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(this._loadFileKey(), 'hex'), iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
  }

  decrypt(b64) {
    const s = String(b64 || '');
    if (s.startsWith(PREFIX)) {
      const raw = Buffer.from(s.slice(PREFIX.length), 'base64');
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const enc = raw.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(this._loadFileKey(), 'hex'), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    }
    // 无前缀 = safeStorage 轨旧密文；本实例若因 safeStorage 不可用而处于 file-key 轨则无法解，
    // 给出可行动错误（调用方逐条捕获：提示用户重新录入该凭证）
    if (!this.safeStorage?.decryptString) {
      throw new Error('该凭证由系统钥匙串加密，当前环境 safeStorage 不可用，请重新填写 API Key');
    }
    return this.safeStorage.decryptString(Buffer.from(s, 'base64'));
  }
}

module.exports = { CredentialCrypto, PREFIX };

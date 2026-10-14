// credentialCrypto 双轨测试：file-key 轨（AES-256-GCM 往返 / 密钥文件 0600 / 跨实例同钥 / 篡改拒绝）
// + safeStorage 轨（mock）无前缀 + 旧 safeStorage 密文经 v2 轨实例的兼容路由
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { CredentialCrypto, PREFIX } = require('../main/credentialCrypto');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-credtest-'));

(async () => {
  // ── 轨 2：safeStorage 缺失 → file-key ──
  const c1 = new CredentialCrypto(tmp, undefined);
  check('safeStorage 缺失时 scheme=file-key', c1.scheme === 'file-key');
  const enc = c1.encrypt('sk-secret-key-123');
  check('密文带 v2: 前缀（AES-GCM 轨）', String(enc).startsWith(PREFIX));
  check('明文不泄漏', !String(enc).includes('sk-secret'));
  check('file-key 轨解密往返', c1.decrypt(enc) === 'sk-secret-key-123');
  const kf = path.join(tmp, 'credential.key');
  check('密钥文件已创建', fs.existsSync(kf));
  if (process.platform !== 'win32') {
    check('密钥文件权限 0600', (fs.statSync(kf).mode & 0o777) === 0o600);
  }
  // 跨实例（同 userData）可解
  const c2 = new CredentialCrypto(tmp, undefined);
  check('第二个实例复用同一密钥可解密', c2.decrypt(enc) === 'sk-secret-key-123');
  // 篡改密文 → GCM 校验失败必须抛错
  const raw = Buffer.from(enc.slice(PREFIX.length), 'base64');
  raw[raw.length - 1] ^= 0xff;
  let tamperRejected = false;
  try { c1.decrypt(PREFIX + raw.toString('base64')); } catch { tamperRejected = true; }
  check('密文篡改被 GCM 校验拒绝', tamperRejected === true);

  // ── 轨 1：mock safeStorage 可用 → 无前缀 ──
  const mock = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`SS:${s}`),
    decryptString: (b) => Buffer.from(b).toString('utf8').slice(3),
  };
  const c3 = new CredentialCrypto(tmp, mock);
  check('safeStorage 可用时 scheme=safeStorage', c3.scheme === 'safeStorage');
  const enc2 = c3.encrypt('abc');
  check('safeStorage 轨密文无 v2: 前缀', !String(enc2).startsWith(PREFIX));
  check('safeStorage 轨解密往返', c3.decrypt(enc2) === 'abc');

  // ── 兼容：同轨跨实例解密（c3 也有 safeStorage）──
  check('safeStorage 轨跨实例解密', c3.decrypt(enc2) === 'abc');
  // ── file-key 轨实例遇 safeStorage 旧密文 → 可行动错误（调用方逐条兜底）──
  let legacyClearError = false;
  try { c1.decrypt(enc2); } catch (e) { legacyClearError = String(e.message).includes('重新填写'); }
  check('file-key 实例解旧轨密文给出可行动错误', legacyClearError === true);
  // ── 探测抛错（如 early-ready 调用）→ 自动降级 file-key ──
  const c4 = new CredentialCrypto(tmp, { isEncryptionAvailable: () => { throw new Error('not ready'); } });
  check('safeStorage 探测抛错时降级 file-key', c4.scheme === 'file-key');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });

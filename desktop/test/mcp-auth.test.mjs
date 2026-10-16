// T7 通用 OAuth 2.1 引擎端到端测试（2026-10-16）
//
// 全真实 http mock（不 mock 传输层）：
//   - 授权服务器：/authorize 302 回 loopback（校验 PKCE S256）、/token 校验 code_verifier、
//     /register DCR、/.well-known/oauth-protected-resource + oauth-authorization-server 元数据
//   - MCP 资源服务器：无有效 token 401 + WWW-Authenticate resource_metadata；有 token 完成
//     initialize/tools/list 握手
//   - 假授权窗口：fetch 授权 URL 跟随重定向（等价浏览器行为）
// 覆盖：发现链、DCR、PKCE、加密落盘、过期自动续期、Bearer 注入、401 续期重试、
//       needsAuth 标记、preset 二级回落、三级如实披露。
import { createRequire } from 'node:module';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { McpAuthManager } = require('../main/mcpAuth');
const { CredentialCrypto } = require('../main/credentialCrypto');
const mcp = require('../main/mcpClient');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-test-'));
const b64url = (buf) => Buffer.from(buf).toString('base64url');

// ── mock：授权服务器 + MCP 资源服务器合一 ──
const S = {
  serveMetadata: true,   // false → 发现链断裂（测 preset 回落 / 如实披露）
  noDcr: false,          // true → AS 元数据不带 registration_endpoint
  validTokens: new Set(),// /mcp 接受的 Bearer 值集合
  allowAnonymous: false, // true → 无 token 也放行握手（deepwiki 类免授权 http 服务）
  refreshSeq: 0,
  captured: {
    authorizeParams: null,   // /authorize 收到的 query
    storedChallenge: '',     // /authorize 记录的 code_challenge
    verifierOk: false,       // /token 校验 sha256(code_verifier) === challenge
    registrationBody: null,  // /register 收到的 JSON
    tokenGrants: [],         // 依次记录的 grant_type
    mcpAuthHeaders: [],      // /mcp 收到的 Authorization 头
    lastResource: '',        // /authorize 收到的 resource 参数
  },
};

function startMockServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const u = new URL(req.url, 'http://127.0.0.1');
        const base = `http://127.0.0.1:${srv.address().port}`;
        const json = (code, obj, headers = {}) => {
          res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
          res.end(JSON.stringify(obj));
        };

        if (req.method === 'GET' && u.pathname === '/.well-known/oauth-protected-resource') {
          if (!S.serveMetadata) return json(404, { error: 'not found' });
          return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
        }
        if (req.method === 'GET' && u.pathname === '/.well-known/oauth-authorization-server') {
          if (!S.serveMetadata) return json(404, { error: 'not found' });
          const meta = {
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            scopes_supported: ['read'],
          };
          if (!S.noDcr) meta.registration_endpoint = `${base}/register`;
          return json(200, meta);
        }
        if (req.method === 'POST' && u.pathname === '/register') {
          S.captured.registrationBody = JSON.parse(body || '{}');
          return json(201, { client_id: 'dyn-client-42' });
        }
        if (req.method === 'GET' && u.pathname === '/authorize') {
          const q = Object.fromEntries(u.searchParams.entries());
          S.captured.authorizeParams = q;
          S.captured.lastResource = q.resource || '';
          if (q.code_challenge_method !== 'S256' || !q.code_challenge) {
            return json(400, { error: 'invalid_request: PKCE S256 required' });
          }
          S.captured.storedChallenge = q.code_challenge;
          const back = new URL(q.redirect_uri);
          back.searchParams.set('code', 'AUTH-CODE');
          back.searchParams.set('state', q.state || '');
          res.writeHead(302, { Location: back.toString() });
          res.end();
          return;
        }
        if (req.method === 'POST' && u.pathname === '/token') {
          const f = Object.fromEntries(new URLSearchParams(body).entries());
          S.captured.tokenGrants.push(f.grant_type);
          if (f.grant_type === 'authorization_code') {
            const okCode = f.code === 'AUTH-CODE';
            const okVerifier = f.code_verifier
              && b64url(crypto.createHash('sha256').update(f.code_verifier).digest()) === S.captured.storedChallenge;
            S.captured.verifierOk = okCode && okVerifier;
            if (!S.captured.verifierOk) return json(400, { error: 'invalid_grant', error_description: 'PKCE 校验失败' });
            // expires_in 为负：落盘即过期 → 逼出 getAccessToken 的自动续期路径
            return json(200, { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: -10, token_type: 'Bearer' });
          }
          if (f.grant_type === 'refresh_token') {
            if (f.refresh_token !== 'RT-1') return json(400, { error: 'invalid_grant' });
            S.refreshSeq += 1;
            return json(200, { access_token: `AT-${S.refreshSeq + 1}`, refresh_token: 'RT-1', expires_in: 3600, token_type: 'Bearer' });
          }
          return json(400, { error: 'unsupported_grant_type' });
        }
        if (req.method === 'POST' && u.pathname === '/mcp') {
          const bearer = String(req.headers.authorization || '');
          S.captured.mcpAuthHeaders.push(bearer);
          if (!S.validTokens.has(bearer.replace(/^Bearer\s+/i, '')) && !(S.allowAnonymous && !bearer)) {
            res.writeHead(401, {
              'Content-Type': 'application/json',
              'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource"`,
            });
            return res.end(JSON.stringify({ error: 'unauthorized' }));
          }
          const msg = JSON.parse(body || '{}');
          if (msg.method === 'initialize') {
            return json(200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock-oauth-mcp', version: '1.0' } } });
          }
          if (msg.method === 'tools/list') {
            return json(200, { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'search', description: '搜索', inputSchema: { type: 'object' } }] } });
          }
          return json(404, { jsonrpc: '2.0', id: msg.id ?? null, error: { message: 'method not found' } });
        }
        json(404, { error: 'not found' });
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const srv = await startMockServer();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const mcpUrl = `${base}/mcp`;

  // 假授权窗口：fetch 授权 URL，undici 跟随 302 打到引擎的 loopback 回调
  let capturedAuthUrl = '';
  let closedWindows = 0;
  const openAuthWindow = (url) => {
    capturedAuthUrl = url;
    fetch(url, { redirect: 'follow' }).then((r) => r.text()).catch(() => {});
    return { close: () => { closedWindows += 1; } };
  };

  const cc = new CredentialCrypto(path.join(tmpRoot, 'vault'), undefined); // 纯 Node → file-key 轨
  const storeFile = path.join(tmpRoot, 'mcp-oauth.json');
  const am = new McpAuthManager({ storeFile, credentialCrypto: cc, openAuthWindow, log: () => {} });

  // ── 1. 发现链 + DCR + PKCE 授权全流程 ──
  {
    const r = await am.authorize('notion', { url: mcpUrl });
    check('发现链授权成功（level=discovery）', r.ok === true && r.level === 'discovery', r.error || '');
    check('DCR 以公共客户端注册（auth_method=none + loopback 回调）',
      S.captured.registrationBody?.token_endpoint_auth_method === 'none'
      && /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(S.captured.registrationBody?.redirect_uris?.[0] || ''),
      JSON.stringify(S.captured.registrationBody?.redirect_uris || ''));
    check('授权 URL 带 PKCE S256 与 resource 参数（RFC 7636/8707）',
      /code_challenge_method=S256/.test(capturedAuthUrl) && S.captured.lastResource === base,
      `resource=${S.captured.lastResource}`);
    check('令牌端点校验 code_verifier 与 challenge 匹配', S.captured.verifierOk === true);
    check('授权后 hasStoredAuth 为真', am.hasStoredAuth('notion') === true);
    check('授权完成即关闭授权窗口', closedWindows === 1);
  }

  // ── 2. 加密落盘：文件无明文令牌，可解密还原 ──
  {
    const raw = fs.readFileSync(storeFile, 'utf8');
    check('落盘文件不含明文 access/refresh 令牌',
      !raw.includes('AT-1') && !raw.includes('RT-1') && raw.includes('v2:'));
    const rec = JSON.parse(raw).notion;
    check('解密还原令牌与元数据',
      cc.decrypt(rec.access) === 'AT-1' && cc.decrypt(rec.refresh) === 'RT-1'
      && rec.clientId === 'dyn-client-42' && rec.tokenEndpoint === `${base}/token`);
  }

  // ── 3. 过期自动续期（expires_in=-10 落盘即过期）──
  {
    const tok = await am.getAccessToken('notion');
    check('getAccessToken 对过期令牌自动续期', tok === 'AT-2', `got=${tok}`);
  }

  // ── 4. mcpClient：Bearer 注入 + 握手成功 ──
  const auth = {
    getHeader: async () => { const t = await am.getAccessToken('notion'); return t ? `Bearer ${t}` : null; },
    refresh: async () => { const t = await am.refreshFor('notion'); return t ? `Bearer ${t}` : null; },
  };
  S.validTokens = new Set(['AT-2']);
  {
    const r = await mcp.connectMcpServer({ name: 'notion', transport: 'http', url: mcpUrl, headers: {}, auth });
    check('OAuth 连接握手成功并列出工具', r.ok === true && r.toolCount === 1, r.error || '');
    check('请求携带 Bearer 头', S.captured.mcpAuthHeaders.includes('Bearer AT-2'));
  }

  // ── 5. 401 → 续期 → 重试一次成功 ──
  {
    S.validTokens = new Set(['AT-3']); // 服务端只认新续期令牌
    const s = mcp.getMcpServer('notion');
    const list = await mcp.mcpRpc(s, 'tools/list', {});
    check('401 后自动续期并重试成功', !!list?.tools?.length);
    check('重试序列：旧令牌 401 → 新令牌 200',
      S.captured.mcpAuthHeaders.slice(-2).join('|') === 'Bearer AT-2|Bearer AT-3',
      S.captured.mcpAuthHeaders.slice(-2).join('|'));
  }

  // ── 6. 全部令牌失效 → needsAuth 标记 ──
  {
    mcp.disconnectMcpServer('notion');
    S.validTokens = new Set();
    const r = await mcp.connectMcpServer({ name: 'notion', transport: 'http', url: mcpUrl, headers: {}, auth });
    check('续期后仍 401 → 连接失败且 needsAuth=true',
      r.ok === false && r.needsAuth === true && /401|授权/.test(r.error), r.error || '');
  }

  // ── 6.5 免授权 http 服务（deepwiki 类）：挂了钩子但无令牌 → 匿名直连不受影响 ──
  {
    S.allowAnonymous = true;
    const anonAuth = {
      getHeader: async () => { const t = await am.getAccessToken('anon-svc'); return t ? `Bearer ${t}` : null; },
      refresh: async () => null,
    };
    const r = await mcp.connectMcpServer({ name: 'anon-svc', transport: 'http', url: mcpUrl, headers: {}, auth: anonAuth });
    check('无存储令牌 + auth 钩子 → 匿名握手成功（不注入 Authorization）',
      r.ok === true && r.toolCount === 1, r.error || '');
    S.allowAnonymous = false;
  }

  // ── 7. mcpRpc 重包装不丢 mcpAuthRequired 标记 ──
  {
    const fake = {
      pending: new Map(), nextId: 1,
      transport: { send: async () => { const e = new Error('x'); e.mcpAuthRequired = true; throw e; } },
    };
    const err = await mcp.mcpRpc(fake, 'tools/list', {}).catch((e) => e);
    check('mcpRpc 透传 mcpAuthRequired 标记', err instanceof Error && err.mcpAuthRequired === true);
  }

  // ── 8. 二级回落：目录 oauth_preset ──
  {
    S.serveMetadata = false; // 发现链断裂
    const r = await am.authorize('preset-svc', {
      url: mcpUrl,
      preset: { authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, client_id: 'preset-client' },
    });
    check('发现失败时 preset 回落授权成功（level=preset）', r.ok === true && r.level === 'preset', r.error || '');
    const raw = fs.readFileSync(storeFile, 'utf8');
    check('preset 授权同样加密落盘', JSON.parse(raw)['preset-svc']?.clientId === 'preset-client' && raw.includes('v2:'));
  }

  // ── 9. 三级披露：无发现且无 preset / AS 不支持 DCR ──
  {
    const r1 = await am.authorize('none-svc', { url: mcpUrl });
    check('无发现且无 preset → 如实披露（不臆造端点）',
      r1.ok === false && /官方文档/.test(r1.error), r1.error || '');
    S.serveMetadata = true; S.noDcr = true;
    const r2 = await am.authorize('nodcr-svc', { url: mcpUrl });
    check('AS 不支持 DCR 且无 preset → 如实披露', r2.ok === false && /DCR/.test(r2.error), r2.error || '');
  }

  // ── 10. 参数校验 ──
  {
    const noName = await am.authorize('', { url: mcpUrl });
    const noUrl = await am.authorize('x', {});
    check('缺 name/url 直接拒绝', noName.ok === false && noUrl.ok === false);
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  srv.close();
  mcp.killAllMcpServers();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  process.exit(fail === 0 ? 0 : 1);
})();

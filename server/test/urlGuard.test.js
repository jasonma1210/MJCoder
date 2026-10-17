// 上游地址校验（SSRF 防护）回归测试
// 目标：锁死「只允许公网 http/https」这一边界，禁止协议 / 内网 / 环回 / 元数据 / IPv4-mapped 全部拒绝
// 运行：node test/urlGuard.test.js（不依赖数据库，域名用例注入 lookup stub，结果确定）
const { assertSafeUpstream, UrlGuardError } = require('../src/lib/urlGuard');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[通过]' : '[失败]'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// 注入 DNS 结果，避免用例受网络与真实解析影响
const stub = (records) => async () => records;

async function expectPass(url, deps) {
  try {
    const parsed = await assertSafeUpstream(url, deps);
    return { ok: parsed instanceof URL, parsed };
  } catch (e) {
    return { ok: false, err: e };
  }
}

async function expectReject(url, deps) {
  try {
    await assertSafeUpstream(url, deps);
    return null;
  } catch (e) {
    return e;
  }
}

async function main() {
  // 允许：公网域名（stub 解析到公网 IP）与公网 IP 字面量
  const allow = [
    { url: 'https://api.openai.com/v1', deps: { lookup: stub([{ address: '104.18.33.45', family: 4 }]) } },
    { url: 'http://example.com', deps: { lookup: stub([{ address: '93.184.216.34', family: 4 }]) } },
    { url: 'https://8.8.8.8/v1' },
    { url: 'https://[2001:4860:4860::8888]/v1' },
  ];
  for (const c of allow) {
    const r = await expectPass(c.url, c.deps);
    check(`允许公网地址 ${c.url}`, r.ok, r.err ? r.err.message : '');
  }

  // 允许：域名同时有多条记录且全为公网
  const rMulti = await expectPass('https://api.example.com/v1', {
    lookup: stub([
      { address: '104.18.33.45', family: 4 },
      { address: '2606:4700::6812:212d', family: 6 },
    ]),
  });
  check('允许公网域名（多记录全公网）', rMulti.ok, rMulti.err ? rMulti.err.message : '');

  // 拒绝：协议
  const badProto = [
    { url: 'file:///etc/passwd', label: 'file 协议' },
    { url: 'ftp://x.com', label: 'ftp 协议' },
    { url: 'gopher://127.0.0.1:6379/_INFO', label: 'gopher 协议' },
    { url: 'data:text/plain,hi', label: 'data 协议' },
  ];
  for (const c of badProto) {
    const e = await expectReject(c.url);
    check(
      `拒绝${c.label} ${c.url}`,
      e instanceof UrlGuardError && e.code === 'UNSAFE_UPSTREAM',
      e ? e.message : '未抛错（存在放行风险）'
    );
  }

  // 拒绝：IPv4 字面量（内网 / 环回 / 元数据 / 未指定）
  const badV4 = [
    'http://127.0.0.1',
    'http://127.0.0.1:8080/v1',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.1.2.3',
    'http://172.16.0.1',
    'http://192.168.1.1',
    'http://0.0.0.0',
    'http://100.64.0.1',
    'http://198.18.0.1',
    'http://224.0.0.1',
    'http://240.0.0.1',
    // URL 解析会归一化的变形写法，也必须命中
    'http://127.1',
    'http://0x7f.0.0.1',
  ];
  for (const url of badV4) {
    const e = await expectReject(url);
    check(`拒绝 IPv4 内网/保留地址 ${url}`, e instanceof UrlGuardError, e ? e.message : '未抛错（存在放行风险）');
  }

  // 拒绝：localhost 及别名
  const badLocal = ['http://localhost:3001', 'http://localhost.', 'http://api.localhost'];
  for (const url of badLocal) {
    const e = await expectReject(url);
    check(`拒绝本机别名 ${url}`, e instanceof UrlGuardError, e ? e.message : '未抛错（存在放行风险）');
  }

  // 拒绝：IPv6 环回 / 未指定 / ULA / 链路本地 / IPv4-mapped
  const badV6 = [
    'http://[::1]',
    'http://[::]',
    'http://[fc00::1]',
    'http://[fd12:3456::1]',
    'http://[fe80::1]',
    'http://[::ffff:127.0.0.1]',
    'http://[::ffff:169.254.169.254]',
  ];
  for (const url of badV6) {
    const e = await expectReject(url);
    check(`拒绝 IPv6 内网/特殊地址 ${url}`, e instanceof UrlGuardError, e ? e.message : '未抛错（存在放行风险）');
  }

  // 拒绝：域名解析到私网（含「公网 + 私网」混合记录，任一命中即拒）
  const ePrivate = await expectReject('http://evil.example', { lookup: stub([{ address: '10.0.0.5', family: 4 }]) });
  check(
    '拒绝解析到私网的域名 evil.example → 10.0.0.5',
    ePrivate instanceof UrlGuardError && ePrivate.message.includes('10.0.0.5'),
    ePrivate ? ePrivate.message : '未抛错（存在放行风险）'
  );

  const eMixed = await expectReject('http://evil.example', {
    lookup: stub([
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.10', family: 4 },
    ]),
  });
  check('拒绝混合解析（公网 + 私网任一命中）', eMixed instanceof UrlGuardError, eMixed ? eMixed.message : '未抛错（存在放行风险）');

  const eMapped = await expectReject('http://evil.example', { lookup: stub([{ address: '::ffff:127.0.0.1', family: 6 }]) });
  check('拒绝域名解析到 IPv4-mapped 环回', eMapped instanceof UrlGuardError, eMapped ? eMapped.message : '未抛错（存在放行风险）');

  // 拒绝：DNS 解析失败（fail-closed）
  const eDns = await expectReject('http://no-such.example', {
    lookup: async () => {
      const err = new Error('getaddrinfo ENOTFOUND');
      err.code = 'ENOTFOUND';
      throw err;
    },
  });
  check('DNS 解析失败时拒绝（fail-closed）', eDns instanceof UrlGuardError, eDns ? eDns.message : '未抛错（存在放行风险）');

  // 错误消息不得回显路径与查询串（base_url 里可能带 token）
  const eLeak = await expectReject('http://127.0.0.1:8080/v1/secret?api_key=sk-super-secret');
  const msg = eLeak ? eLeak.message : '';
  check(
    '错误消息不含查询串/路径（不泄露 token）',
    !!eLeak && !msg.includes('sk-super-secret') && !msg.includes('/v1/secret') && !msg.includes('api_key'),
    msg
  );

  const eLeak6 = await expectReject('file:///etc/passwd?token=sk-super-secret');
  const msg6 = eLeak6 ? eLeak6.message : '';
  check('非法协议错误不泄露原始 URL', !!eLeak6 && !msg6.includes('sk-super-secret') && !msg6.includes('/etc/passwd'), msg6);

  // 真实 DNS 路径（信息项，不计入通过率；离线环境可能失败，属环境问题）
  // ── 本地模型白名单（2026-10-17 修正）──
  // 产品明确支持「模型无关 + 本机 Ollama」，自托管 server 走 127.0.0.1:11434 是核心用法。
  // 一刀切拒私网 = 把核心能力打死；因此提供 ALLOW_PRIVATE_UPSTREAM=1 / deps.allowPrivate，
  // 但元数据端点无论如何都拒。
  const a1 = await expectPass('http://127.0.0.1:11434/v1', { allowPrivate: true });
  check('allowPrivate：放行本机 Ollama（127.0.0.1:11434）', a1.ok, a1.err && a1.err.message);

  const a2 = await expectPass('http://localhost:11434/v1', { allowPrivate: true });
  check('allowPrivate：放行 localhost:11434（Ollama 常见写法）', a2.ok, a2.err && a2.err.message);

  const a3 = await expectPass('http://192.168.1.9:8000/v1', { allowPrivate: true });
  check('allowPrivate：放行局域网自建模型服务', a3.ok, a3.err && a3.err.message);

  const a4 = await expectReject('http://169.254.169.254/latest/meta-data/', { allowPrivate: true });
  check('allowPrivate：仍拒绝云元数据 169.254.169.254（开关不得顺带打开）', !a4.ok, a4.err && a4.err.message);

  const a5 = await expectReject('http://[fe80::1]/v1', { allowPrivate: true });
  check('allowPrivate：仍拒绝 IPv6 链路本地 fe80::/10', !a5.ok, a5.err && a5.err.message);

  const a6 = await expectReject('http://127.0.0.1:11434/v1');
  check('默认（未开 allowPrivate）：仍拒绝 127.0.0.1 —— 云端部署的默认姿态', !a6.ok, a6.err && a6.err.message);

  try {
    const parsed = await assertSafeUpstream('https://example.com');
    console.log(`[信息] 真实 DNS 解析 example.com → ${parsed.host}，校验通过`);
  } catch (e) {
    console.log(`[信息] 真实 DNS 校验未通过（可能是沙箱无网络）：${e.message}`);
  }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.error('存在失败用例');
    process.exit(1);
  }
  console.log('上游地址 SSRF 校验回归测试全部通过');
}

main().catch((e) => {
  console.error('测试异常', e);
  process.exit(1);
});

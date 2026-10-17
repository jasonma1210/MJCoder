// 上游地址校验（SSRF 防护）
// 为什么需要：chat 代理的 base_url 来自用户/管理员填写，若不校验协议与目标网段，
// 代理会被当作跳板访问内网服务、云厂商元数据（169.254.169.254）等本不该触达的地址。
const dns = require('dns');
const net = require('net');

class UrlGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UrlGuardError';
    this.code = 'UNSAFE_UPSTREAM';
  }
}

// 禁止的 IPv4 网段：命中任一条即拒绝。顺序无关，仅按可读性排列。
const BLOCKED_V4 = [
  ['0.0.0.0', 8, '未指定/当前网络地址'],
  ['10.0.0.0', 8, '私有网络'],
  ['100.64.0.0', 10, '运营商级 NAT 保留段'],
  ['127.0.0.0', 8, '环回地址'],
  ['169.254.0.0', 16, '链路本地地址（含云元数据 169.254.169.254）'],
  ['172.16.0.0', 12, '私有网络'],
  ['192.0.0.0', 24, 'IETF 协议专用地址'],
  ['192.168.0.0', 16, '私有网络'],
  ['198.18.0.0', 15, '网络基准测试保留段'],
  ['224.0.0.0', 4, '组播地址'],
  ['240.0.0.0', 4, '保留地址'],
];

function v4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function v4InCidr(ipInt, netInt, bits) {
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((netInt & mask) >>> 0);
}

// 返回命中的禁止网段描述；未命中返回 null
function v4Reason(ip) {
  const ipInt = v4ToInt(ip);
  if (ipInt === null) return null;
  for (const [base, bits, label] of BLOCKED_V4) {
    if (v4InCidr(ipInt, v4ToInt(base), bits)) {
      return `${label}（命中 ${base}/${bits}）`;
    }
  }
  return null;
}

// 把 IPv6 展开成 8 个 16 位分组；支持 :: 压缩与内嵌 IPv4（::ffff:127.0.0.1）
function parseIPv6(input) {
  let s = String(input).trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  // 去掉 zone id（fe80::1%eth0），只关心地址本身
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);
  if (!s.includes(':')) return null;

  const halves = s.split('::');
  if (halves.length > 2) return null;

  const expand = (part) => {
    if (!part) return [];
    const items = part.split(':');
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.includes('.')) {
        // 内嵌 IPv4 只能出现在最后一组
        if (i !== items.length - 1) return null;
        const p = it.split('.').map(Number);
        if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        out.push((p[0] << 8) | p[1], (p[2] << 8) | p[3]);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(it)) return null;
        out.push(parseInt(it, 16));
      }
    }
    return out;
  };

  const head = expand(halves[0]);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = expand(halves[1]);
  if (!tail) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array(fill).fill(0), ...tail];
}

// 返回命中的禁止规则描述；未命中返回 null
function v6Reason(ip) {
  const g = parseIPv6(ip);
  if (!g) return null;
  const allZero = g.every((x) => x === 0);
  if (allZero) return 'IPv6 未指定地址（::）';
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'IPv6 环回地址（::1）';
  // IPv4-mapped ::ffff:a.b.c.d：按 IPv4 规则再判一次，防止用映射形式绕过
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const mapped = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    const r = v4Reason(mapped);
    if (r) return `IPv4-mapped ${mapped}，${r}`;
    return null;
  }
  // 注意 g[0] 是 16 位分组，判断前缀要取高 8 位
  if (((g[0] >> 8) & 0xfe) === 0xfc) return 'IPv6 唯一本地地址（命中 fc00::/7）';
  if ((g[0] >> 8) === 0xfe && ((g[0] & 0xc0) === 0x80)) return 'IPv6 链路本地地址（命中 fe80::/10）';
  return null;
}

/** 即使在 allowPrivate 下也必须拒绝的地址：链路本地 / 未指定 / 云元数据 */
function isMetadataV4(addr) {
  return /^169\.254\./.test(addr) || /^0\./.test(addr);
}
function isMetadataV6(addr) {
  const a = String(addr).toLowerCase();
  return a === '::' || ((a.startsWith('::ffff:') ? a.slice(7) : a) !== a && isMetadataV4(a.slice(7))) || /^fe80:/.test(a);
}

function isLocalhostName(hostname) {
  const h = hostname.replace(/\.+$/, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost');
}

/**
 * 校验上游地址是否允许访问。
 * @param {string} rawUrl 待校验的完整 URL
 * @param {{ lookup?: Function }} [deps] 仅测试注入用；默认 dns.promises.lookup
 * @returns {Promise<URL>} 校验通过时返回解析后的 URL
 * @throws {UrlGuardError} 协议非法、主机名非法、命中禁止网段或解析失败
 *
 * 说明：域名场景会对全部 A/AAAA 记录逐条判断（任一命中即拒绝），
 * 这样能挡住「解析到公网 + 内网多条记录」的一半 rebinding 场景；
 * 但校验与实际连接之间仍有 TOCTOU 窗口，最终连通性由调用方负责。
 */
async function assertSafeUpstream(rawUrl, deps = {}) {
  // 2026-10-17（P1-2 修正）：本产品明确支持「模型无关 + 本机 Ollama」，
  // 自托管 server 走 http://127.0.0.1:11434 是核心用法。若一律拒私网，这个修复本身就成了回归。
  // 因此提供显式开关 ALLOW_PRIVATE_UPSTREAM=1（默认关）：开启后放行私网/回环，
  // 但**链路本地与元数据端点（169.254.0.0/16、0.0.0.0/8、fe80::/10、::）永远拒**——
  // 云上元数据外带是这类代理最危险的场景，不该被一个「方便开关」顺带打开。
  const allowPrivate = deps.allowPrivate === true || process.env.ALLOW_PRIVATE_UPSTREAM === '1';
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    // 不回显原始串：可能带 token
    throw new UrlGuardError('上游地址不是合法 URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlGuardError(`仅允许 http/https 协议（收到 ${url.protocol.replace(/:$/, '')}:）`);
  }

  const hostname = url.hostname;
  if (!hostname) {
    throw new UrlGuardError('上游地址缺少主机名');
  }

  const bare = hostname.replace(/^\[|\]$/g, '');

  // IP 字面量直接判断，不走 DNS
  const ipFamily = net.isIP(bare);
  if (ipFamily === 4) {
    const reason = v4Reason(bare);
    if (reason && !(allowPrivate && !isMetadataV4(bare))) {
      throw new UrlGuardError(`主机 ${bare} 不允许访问：${reason}`);
    }
    return url;
  }
  if (ipFamily === 6) {
    const reason = v6Reason(bare);
    if (reason && !(allowPrivate && !isMetadataV6(bare))) {
      throw new UrlGuardError(`主机 ${hostname} 不允许访问：${reason}`);
    }
    return url;
  }

  // 域名：显式拒绝本机别名（allowPrivate 下放行——Ollama 常写 localhost:11434）
  if (isLocalhostName(hostname) && !allowPrivate) {
    throw new UrlGuardError(`主机 ${hostname.replace(/^\[|\]$/g, '')} 不允许访问：本机回环别名`);
  }
  if (isLocalhostName(hostname)) return url;

  const lookup = deps.lookup || dns.promises.lookup;
  let records;
  try {
    records = await lookup(hostname, { all: true });
  } catch (e) {
    // 解析不了就按失败处理（fail-closed），避免绕过校验
    throw new UrlGuardError(`主机 ${hostname} 解析失败：${e.code || 'DNS_ERROR'}`);
  }
  const list = Array.isArray(records) ? records : records ? [records] : [];
  if (list.length === 0) {
    throw new UrlGuardError(`主机 ${hostname} 没有可用的 A/AAAA 记录`);
  }
  for (const rec of list) {
    const addr = rec && rec.address;
    if (!addr) continue;
    const reason = net.isIP(addr) === 6 ? v6Reason(addr) : v4Reason(addr);
    const meta = net.isIP(addr) === 6 ? isMetadataV6(addr) : isMetadataV4(addr);
    if (reason && !(allowPrivate && !meta)) {
      throw new UrlGuardError(`主机 ${hostname} 不允许访问：解析到 ${addr}，${reason}`);
    }
  }
  return url;
}

module.exports = { assertSafeUpstream, UrlGuardError };

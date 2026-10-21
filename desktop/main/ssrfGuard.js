// SSRF 判定 —— 单一事实来源（第八轮 D-802，2026-10-21）
//
// 为什么必须重写而不是补两条正则：
//   原实现（webTools.js 内的 isPrivateHost）用**字符串前缀**匹配主机名：
//     h === '::1' / ^f[cd] / fe80 / ^127\. / ^10\. …
//   而 WHATWG `new URL(u).hostname` 对 IPv6 返回的是**带方括号**的形式：
//     'http://[::1]/'            → hostname = '[::1]'
//     'http://[fd00::1]/'        → hostname = '[fd00::1]'
//     'http://[fe80::1]/'        → hostname = '[fe80::1]'
//     'http://[::ffff:127.0.0.1]/' → hostname = '[::ffff:7f00:1]'
//   于是 `h === '::1'` 永远不成立、`^f[cd]` / `fe80` 也永不命中 ——
//   **全部 IPv6 目标一律被放行**，包括回环 `[::1]`、ULA、链路本地、IPv4-mapped。
//   这不是「少覆盖几种写法」，而是「整个 IPv6 地址族没有防护」。
//
// 一处必须写清的**实测更正**（避免后人重复误判）：
//   审查报告最初列的另外三种绕过（十进制 `2130706433` / 十六进制 `0x7f.1` /
//   八进制 `0177.0.0.1`）**在当前调用链上不成立** —— WHATWG URL 已经把三者归一成
//   `127.0.0.1`，随后被 `^127\.` 拦住。这三种只在「直接调用 isPrivateHost(原始主机名)」
//   时才漏（例如未来的新调用方自己解析 URL）。本模块仍然兼容它们，
//   理由是**判据不该依赖调用方是否先做了归一**：防御要建在函数自己身上。
//
// 本模块的两层职责：
//   ① 主机名归一：IPv6 去括号并展开、IPv4 支持 inet_aton 的 1~4 段与十/十六/八进制写法；
//   ② 私网判定：IPv4 私网/回环/链路本地/CGNAT/保留段；IPv6 回环/未指定/ULA/链路本地/内嵌 IPv4。
//
// 仍未覆盖（诚实标注）：
//   **字面量主机名**与**解析后地址**两处都已判（见 guardedLookup）。
//   仍不覆盖的情形：目标服务器的**反向代理/CDN 回源**、以及「解析到公网 IP 但该 IP 反向代理到内网」
//   这类网络层构造 —— 那已超出本进程能判定的范围，属部署侧边界。

'use strict';

const dns = require('dns');

/** 去掉 IPv6 的方括号与末尾根点（`[::1]` → `::1`，`example.com.` → `example.com`） */
function normalizeHostInput(hostname) {
  return String(hostname == null ? '' : hostname)
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
}

/**
 * IPv4 宽松解析 → 32 位无符号整数；非 IPv4 字面量返回 null。
 * 支持 inet_aton 语义：1~4 段，每段可写十进制 / `0x` 十六进制 / `0` 前导八进制。
 * （`2130706433` = 127.0.0.1、`0x7f.1` = 127.0.0.1、`0177.0.0.1` = 127.0.0.1）
 */
function parseIpv4ToInt(host) {
  const parts = String(host).split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const n = [];
  for (const p of parts) {
    if (!/^(0x[0-9a-f]+|[0-9]+)$/i.test(p)) return null; // 含字母但非 0x 前缀 ⇒ 是域名，不是 IP
    let v;
    if (/^0x/i.test(p)) v = parseInt(p.slice(2), 16);
    else if (p.length > 1 && p[0] === '0') v = parseInt(p, 8);
    else v = parseInt(p, 10);
    if (!Number.isFinite(v) || v < 0) return null;
    n.push(v);
  }
  const ok = (v, max) => v <= max;
  if (n.length === 1) return ok(n[0], 0xffffffff) ? n[0] >>> 0 : null;
  if (n.length === 2) {
    return ok(n[0], 0xff) && ok(n[1], 0xffffff) ? (((n[0] << 24) | n[1]) >>> 0) : null;
  }
  if (n.length === 3) {
    return ok(n[0], 0xff) && ok(n[1], 0xff) && ok(n[2], 0xffff)
      ? (((n[0] << 24) | (n[1] << 16) | n[2]) >>> 0) : null;
  }
  return n.every((v) => ok(v, 0xff))
    ? (((n[0] << 24) | (n[1] << 16) | (n[2] << 8) | n[3]) >>> 0) : null;
}

/** IPv4 私网 / 回环 / 链路本地 / CGNAT / 保留段判定 */
function isPrivateV4(int) {
  const b = [(int >>> 24) & 0xff, (int >>> 16) & 0xff, (int >>> 8) & 0xff, int & 0xff];
  if (b[0] === 0) return true;                                  // 0.0.0.0/8（含未指定）
  if (b[0] === 10) return true;                                 // 10/8
  if (b[0] === 127) return true;                                // 回环
  if (b[0] === 169 && b[1] === 254) return true;                // 链路本地 + 云元数据 169.254.169.254
  if (b[0] === 172 && b[1] >= 16 && b[1] <= 31) return true;    // 172.16/12
  if (b[0] === 192 && b[1] === 168) return true;                // 192.168/16
  if (b[0] === 100 && b[1] >= 64 && b[1] <= 127) return true;   // CGNAT 100.64/10
  if (b[0] === 192 && b[1] === 0 && b[2] === 0) return true;    // 192.0.0/24 IETF 保留
  if (b[0] === 198 && (b[1] === 18 || b[1] === 19)) return true; // 198.18/15 基准测试
  return false;
}

/**
 * IPv6 宽松解析 → 16 字节数组；非 IPv6 字面量返回 null。
 * 处理 `::` 压缩、全写式（`0:0:0:0:0:0:0:1`）、以及末尾内嵌 IPv4（`::ffff:127.0.0.1`）。
 */
function parseIpv6ToBytes(host) {
  if (!host.includes(':')) return null;
  let s = host;
  // 末尾内嵌 IPv4 → 折成两组 hex（`::ffff:127.0.0.1` 的 hostname 通常是 `::ffff:7f00:1`，
  // 但直接调用本函数时可能拿到点分形式，两种都要能处理）
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const v = parseIpv4ToInt(m[2]);
    if (v == null) return null;
    s = `${m[1]}${((v >>> 16) & 0xffff).toString(16)}:${(v & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (str) => (str ? str.split(':') : []);
  const left = toGroups(halves[0]);
  const right = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  if (halves.length === 1 && missing !== 0) return null; // 无 `::` 时必须恰好 8 组
  const groups = [...left, ...new Array(missing).fill('0'), ...right];
  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

/** IPv6 私网 / 回环 / 未指定 / ULA / 链路本地 / 内嵌 IPv4 判定 */
function isPrivateV6(bytes) {
  const zeros = (from, to) => bytes.slice(from, to).every((x) => x === 0);
  if (zeros(0, 16)) return true;                        // ::  未指定
  if (zeros(0, 15) && bytes[15] === 1) return true;     // ::1 回环
  const v4From = (o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  // ::ffff:a.b.c.d（IPv4-mapped）—— `http://[::ffff:127.0.0.1]/` 走这条
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return isPrivateV4(v4From(12));
  // ::a.b.c.d（IPv4-compatible，已废弃但仍可解析）
  if (zeros(0, 12)) return isPrivateV4(v4From(12));
  if ((bytes[0] & 0xfe) === 0xfc) return true;          // fc00::/7 ULA
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 链路本地
  return false;
}

/**
 * 该主机名是否指向内网 / 本机 / 保留地址。
 * 入参可以是 URL 解析后的 hostname（IPv6 带方括号），也可以是原始主机名 —— 两种都判。
 *
 * @param {string} hostname
 * @returns {boolean} true = 禁止访问
 */
function isPrivateHost(hostname) {
  const raw = String(hostname == null ? '' : hostname).trim().toLowerCase();
  if (!raw) return true;                       // 空主机名：fail-closed
  const h = normalizeHostInput(raw);
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;

  const v4 = parseIpv4ToInt(h);
  if (v4 != null) return isPrivateV4(v4);

  const v6 = parseIpv6ToBytes(h);
  if (v6) return isPrivateV6(v6);

  // 含冒号却既不是 IPv4 也不是可解析的 IPv6：形如畸形地址，按最保守侧处理
  if (h.includes(':')) return true;

  // 域名：本函数只判字面量，解析结果需由 resolve-then-validate 兜（见文件头「仍未覆盖」）
  return false;
}

/**
 * resolve-then-validate：给 `http.request` / `https.request` 用的 `lookup` 钩子。
 *
 * 为什么必须有这一层：`isPrivateHost(url.hostname)` 判的是**字面量**，而真正建连用的是
 * **解析结果**。两者之间就是 DNS rebinding 的空间 —— 一个域名可以第一次解析到公网、
 * 之后解析到 127.0.0.1（或直接返回多条记录，其中一条是内网）。
 * 把判定放进 `lookup`，判的就是即将被连接的那个地址，字符串层与连接层因此不再有缝。
 *
 * 语义细节（别改坏）：
 *   · 只有**全部**解析结果都通过才放行（任一命中内网即拒）—— 部分放行等于给了 rebinding 机会；
 *   · `options.all` 为真时按 Node 约定回数组，否则回 `(err, address, family)`；
 *   · 解析失败照原样回错，不改写错误语义（上层据此报「无法解析」）。
 *
 * @param {string} hostname
 * @param {object|number} options Node 传入的 lookup 选项（也可能是 family 数字）
 * @param {Function} callback
 */
function guardedLookup(hostname, options, callback) {
  const opts = (options && typeof options === 'object') ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [];
    if (list.length === 0) return callback(new Error(`无法解析主机：${hostname}`));
    for (const a of list) {
      if (isPrivateHost(String(a && a.address ? a.address : ''))) {
        return callback(new Error(
          `出于安全考虑禁止访问内网/本机地址：${hostname} 解析到 ${a.address}`));
      }
    }
    if (opts.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

module.exports = {
  isPrivateHost, guardedLookup, parseIpv4ToInt, parseIpv6ToBytes, isPrivateV4, isPrivateV6,
};

// 第八轮 D-802 / 判据 7.7 / 7.8：SSRF 防护的**字面量层**与**解析层**双闸
//
// 缺陷背景（角度 C 实测，本轮已更正一处误判）：
//   原实现用字符串前缀匹配主机名（`h === '::1'` / `^f[cd]` / `fe80` / `^127\.` …），
//   而 WHATWG `new URL(u).hostname` 对 IPv6 返回**带方括号**的形式：
//     'http://[::1]/'              → '[::1]'
//     'http://[fd00::1]/'          → '[fd00::1]'
//     'http://[::ffff:127.0.0.1]/' → '[::ffff:7f00:1]'
//   于是那些前缀判断**永不命中** —— 整个 IPv6 地址族没有防护，`http://[::1]/` 直达回环。
//
// 一处必须记录的**实测更正**（否则后人会重复误判）：
//   报告最初列的十进制 `2130706433` / 十六进制 `0x7f.1` / 八进制 `0177.0.0.1`，
//   **在当前调用链上不构成绕过** —— URL 解析器已把三者归一为 `127.0.0.1`。
//   它们只在「调用方直接传原始主机名」时才漏，因此本套件**两条路径都测**。
//
// 本套件锁五件事：
//   ① URL 解析后的 IPv6 括号形式必须全部拦住（这是原本真正漏掉的一整族）；
//   ② 原始主机名的 IPv4 宽松写法（十/十六/八进制、1~3 段）也必须拦住；
//   ③ IPv4 私网/回环/链路本地/CGNAT/保留段齐全；
//   ④ 公网地址与公网 IPv6 必须放行（防「更严」变「全拒」）；
//   ⑤ resolve-then-validate：解析到内网即拒（DNS rebinding 缝隙）。
const assert = require('node:assert/strict');
const { URL: NodeURL } = require('node:url');
const guard = require('../main/ssrfGuard');
const webTools = require('../main/webTools');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const hostOf = (u) => new NodeURL(u).hostname;

// ── ① URL 解析后的 IPv6 括号形式（原本的整族漏洞）──
const ipv6Blocked = [
  ['http://[::1]/', '[::1] 回环'],
  ['http://[0:0:0:0:0:0:0:1]/', '[0:0:0:0:0:0:0:1] 回环全写式'],
  ['http://[::]/', '[::] 未指定'],
  ['http://[fd00::1]/', '[fd00::1] ULA'],
  ['http://[fc00::1]/', '[fc00::1] ULA'],
  ['http://[fe80::1]/', '[fe80::1] 链路本地'],
  ['http://[::ffff:127.0.0.1]/', '[::ffff:127.0.0.1] IPv4-mapped 回环'],
  ['http://[::ffff:192.168.1.1]/', '[::ffff:192.168.1.1] IPv4-mapped 内网'],
];
for (const [u, label] of ipv6Blocked) {
  check(`① URL 解析后的 ${label} 被拦`, guard.isPrivateHost(hostOf(u)) === true, hostOf(u));
}

// ── ② 原始主机名的 IPv4 宽松写法（直接调用路径）──
const rawBlocked = [
  ['2130706433', '十进制 = 127.0.0.1'],
  ['0x7f.1', '十六进制 = 127.0.0.1'],
  ['0177.0.0.1', '八进制 = 127.0.0.1'],
  ['127.1', '两段 = 127.0.0.1'],
  ['127.0.1', '三段 = 127.0.0.1'],
  ['0', '0 = 0.0.0.0'],
];
for (const [h, label] of rawBlocked) {
  check(`② 原始主机名 ${label} 被拦`, guard.isPrivateHost(h) === true, h);
}

// ── ③ IPv4 私网 / 保留段 ──
const v4Blocked = [
  '127.0.0.1', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255',
  '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '198.18.0.1', '192.0.0.1',
];
for (const h of v4Blocked) {
  check(`③ 私网/保留 ${h} 被拦`, guard.isPrivateHost(h) === true);
}

// ── ④ 公网必须放行（防「更严」变「全拒」）──
const publicHosts = [
  ['example.com', null],
  ['github.com', null],
  ['8.8.8.8', null],
  ['1.1.1.1', null],
  ['172.32.0.1', '紧邻 172.16/12 上边界之外'],
  ['172.15.255.255', '紧邻 172.16/12 下边界之外'],
  ['[2606:4700::1111]', '公网 IPv6（URL 括号形式）'],
  ['2606:4700::1111', '公网 IPv6（原始形式）'],
  ['[::ffff:8.8.8.8]', 'IPv4-mapped 公网'],
];
for (const [h, note] of publicHosts) {
  check(`④ 公网 ${h} 放行${note ? `（${note}）` : ''}`, guard.isPrivateHost(h) === false, h);
}

// ── 边界：畸形输入按 fail-closed ──
check('边界：空主机名 fail-closed', guard.isPrivateHost('') === true);
check('边界：undefined fail-closed', guard.isPrivateHost(undefined) === true);
check('边界：含冒号但非法的形态 fail-closed', guard.isPrivateHost('::gg::1') === true,
  '::gg::1');
check('边界：localhost 子域被拦', guard.isPrivateHost('api.localhost') === true);

// ── ⑤ resolve-then-validate（DNS rebinding 缝隙）──
(async () => {
  const rejectResolvedPrivate = await new Promise((resolve) => {
    guard.guardedLookup('localhost', {}, (err, address) => resolve({ err, address }));
  });
  check('⑤ guardedLookup 拒绝把 localhost 解析成 127.0.0.1',
    !!rejectResolvedPrivate.err && /内网|本机/.test(String(rejectResolvedPrivate.err.message))
      && !rejectResolvedPrivate.address,
    String(rejectResolvedPrivate.err && rejectResolvedPrivate.err.message));

  const unknown = await new Promise((resolve) => {
    guard.guardedLookup('mjcode-nonexistent-host.invalid', {}, (err) => resolve(err));
  });
  check('⑤ guardedLookup 解析失败时照原样回错（不改写错误语义）', !!unknown);

  // webTools 仍 re-export 同一份实现（nativeTools 的 http_request 依赖这条）
  check('⑤ webTools.isPrivateHost 与 ssrfGuard 是同一份实现',
    webTools.isPrivateHost === guard.isPrivateHost);

  console.log(`\nssrf-guard: ${pass}/${pass + fail} 通过`);
  if (fail > 0) process.exitCode = 1;
})();

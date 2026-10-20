// Linux sandbox 可用性**三态诊断**门禁（D-09-A / B2-B-14）
//
// 被治理的问题：改造前 linuxSandboxAvailable() 只返回 true/false，于是
//   「这台机器不是 Linux」「Linux 但 bwrap 没装」「bwrap 装了但建不出隔离命名空间」
// 三种**完全不同**的情况对用户呈现为同一句失败。用户无法判断该装包、该改内核参数，
// 还是根本不该在这台机器找 bubblewrap —— 这是「有信号无信息」的假诊断。
//
// 本套件钉住四件事：
//   ① 返回结构字段齐全（available / reason / detail / hint），reason 落在四值枚举内；
//   ② available ⟺ reason === 'ok'（**双向**：不允许「可用但 reason 不是 ok」，也不允许反之）；
//   ③ 每个 reason 都映射到**非空且非敷衍**的 hint（必须含可执行命令/具体动作）；
//   ④ 本机（darwin）真实调用 → reason === 'not-linux' 且 available === false。
//
// 另有一条**回归门禁**：linuxSandboxAvailable() 必须保持历史静态口径
// （平台 + 二进制存在，不做运行时探测）——它是同步热路径（sandbox.js:210 detectBackend
// ← osSandboxUsable ← 每次 exec），在此起子进程会让每次执行多两次 fork+exec。
//
// 全部用例在 macOS 上可跑：platform / findBwrap / bwrap 二进制均可注入，
// 不依赖本机是否装了 bwrap，也不需要 Linux。
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const linux = require('../main/sandboxLinux');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const REASONS = linux.SANDBOX_STATUS_REASONS;
check('导出 SANDBOX_STATUS_REASONS 且为四值互斥枚举',
  Array.isArray(REASONS) && REASONS.length === 4
  && ['not-linux', 'bwrap-missing', 'bwrap-broken', 'ok'].every((r) => REASONS.includes(r)),
  JSON.stringify(REASONS));
check('导出 linuxSandboxStatus 函数', typeof linux.linuxSandboxStatus === 'function');

// ── 造可注入的假 bwrap 二进制（用于在 darwin 上真实驱动 broken/ok 两条分支）──
// 脚本行为由 FAKE_MODE 决定：
//   'always-ok'   → --version 与隔离探测都成功（→ ok）
//   'version-ok'  → --version 成功，隔离探测失败（→ bwrap-broken，这是最容易漏判的一种）
//   'version-bad' → --version 就失败（→ bwrap-broken）
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-bwrap-probe-'));
const FAKE_SCRIPTS = {
  'always-ok': [
    '#!/bin/sh',
    'case "$1" in',
    '  --version) echo "bubblewrap 0.8.0"; exit 0 ;;',
    '  *) exit 0 ;;',
    'esac',
  ],
  'version-ok': [
    '#!/bin/sh',
    'case "$1" in',
    '  --version) echo "bubblewrap 0.8.0"; exit 0 ;;',
    '  *) echo "bwrap: Creating new namespace failed: Operation not permitted" >&2; exit 1 ;;',
    'esac',
  ],
  'version-bad': [
    '#!/bin/sh',
    'echo "bwrap: error while loading shared libraries: libcap.so.2" >&2',
    'exit 127',
  ],
};
const FAKE = {};
for (const [mode, lines] of Object.entries(FAKE_SCRIPTS)) {
  const p = path.join(TMPDIR, `bwrap-${mode}`);
  fs.writeFileSync(p, `${lines.join('\n')}\n`, { mode: 0o755 });
  fs.chmodSync(p, 0o755);
  FAKE[mode] = p;
}

const STATUS_KEYS = ['available', 'reason', 'detail', 'hint'];
function wellFormed(s, label) {
  const missing = STATUS_KEYS.filter((k) => !(k in (s || {})));
  check(`${label}：四个字段齐全（available/reason/detail/hint）`, missing.length === 0,
    missing.length ? `缺：${missing.join(', ')}` : `reason=${s.reason}`);
  check(`${label}：available 是布尔`, typeof s.available === 'boolean', String(s.available));
  check(`${label}：reason 在四值枚举内`, REASONS.includes(s.reason), String(s.reason));
  check(`${label}：available ⟺ reason === 'ok'（双向）`,
    s.available === (s.reason === 'ok'), `available=${s.available} reason=${s.reason}`);
  check(`${label}：detail 为非空说明文字`, typeof s.detail === 'string' && s.detail.trim().length >= 10,
    `${String(s.detail).length} 字符`);
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// ① not-linux：平台注入为 darwin / win32
// ─────────────────────────────────────────────────────────────────────────────
for (const plat of ['darwin', 'win32', 'freebsd']) {
  const s = wellFormed(linux.linuxSandboxStatus({ platform: plat }), `not-linux(${plat})`);
  check(`not-linux(${plat})：reason === 'not-linux' 且 available === false`,
    s.reason === 'not-linux' && s.available === false, `实际 ${s.reason}/${s.available}`);
  check(`not-linux(${plat})：hint 提到不该装 bwrap（避免误导用户去 apt install）`,
    /不用装|无需|不该/.test(s.hint), s.hint.slice(0, 60));
}

// ─────────────────────────────────────────────────────────────────────────────
// ② bwrap-missing：平台是 linux 但找不到二进制
// ─────────────────────────────────────────────────────────────────────────────
{
  const s = wellFormed(linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => null }), 'bwrap-missing');
  check("bwrap-missing：reason === 'bwrap-missing' 且 available === false",
    s.reason === 'bwrap-missing' && s.available === false, `实际 ${s.reason}/${s.available}`);
  // hint 必须**可执行**：给出真实包管理命令，而不是「请安装 bubblewrap」这种废话
  check('bwrap-missing：hint 含可直接复制的包管理命令（apt/dnf/pacman/apk 至少各一）',
    /apt install bubblewrap/.test(s.hint) && /dnf install bubblewrap/.test(s.hint)
    && /pacman -S bubblewrap/.test(s.hint) && /apk add bubblewrap/.test(s.hint),
    s.hint.slice(0, 80));
  check('bwrap-missing：detail 说明已确认平台为 linux（区分于 not-linux）',
    /linux/i.test(s.detail), s.detail.slice(0, 60));
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ bwrap-broken：二进制可执行，但建不出隔离命名空间
//    —— 这是本次改造的核心：--version 成功 ≠ 可用
// ─────────────────────────────────────────────────────────────────────────────
{
  const s = wellFormed(
    linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => FAKE['version-ok'] }),
    'bwrap-broken(version 成功但隔离失败)',
  );
  check("bwrap-broken：--version 成功但隔离探测失败 ⇒ reason === 'bwrap-broken'",
    s.reason === 'bwrap-broken' && s.available === false, `实际 ${s.reason}/${s.available}`);
  check('bwrap-broken：detail 带上 bwrap 版本号（证明 --version 确实跑通了，不是 finding 失败）',
    /0\.8\.0/.test(s.detail), s.detail.slice(0, 100));
  check('bwrap-broken：detail 带上真实 stderr（Operation not permitted），可用于定位',
    /Operation not permitted/i.test(s.detail), s.detail.slice(0, 140));
  // hint 必须直指内核/容器配置，而不是让用户「重新安装」（重装解决不了 userns 被禁）
  check('bwrap-broken：hint 给出内核/AppArmor/容器三层排查命令',
    /unprivileged_userns_clone/.test(s.hint) && /apparmor_restrict_unprivileged_userns/.test(s.hint)
    && /seccomp=unconfined/.test(s.hint),
    s.hint.slice(0, 100));
  check('bwrap-broken：hint 说明降级后隔离强度下降（不谎称仍等价隔离）',
    /隔离强度.*下降|命令级拦截/.test(s.hint), s.hint.slice(-80));
}
{
  const s = wellFormed(
    linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => FAKE['version-bad'] }),
    'bwrap-broken(--version 就失败)',
  );
  check("bwrap-broken：--version 失败也归为 'bwrap-broken'（二进制在、不可用，不是 missing）",
    s.reason === 'bwrap-broken' && s.available === false, `实际 ${s.reason}/${s.available}`);
  check('bwrap-broken(--version 失败)：detail 带上真实 stderr',
    /libcap\.so/.test(s.detail), s.detail.slice(0, 100));
}
{
  // 二进制路径存在但根本不可执行 → 必须判失败，不能因为「路径存在」就报可用
  const s = wellFormed(
    linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => path.join(TMPDIR, 'no-such-bwrap') }),
    'bwrap-broken(路径不存在)',
  );
  check("bwrap-broken：注入一个不存在的 bwrap 路径 ⇒ 不可用（ENOENT 归类为 broken）",
    s.available === false && s.reason === 'bwrap-broken', `实际 ${s.reason}/${s.available}`);
}
{
  // 超时必须判失败（防卡死的 bwrap 把同步调用方拖死，同时不误报可用）
  const s = wellFormed(
    linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => FAKE['always-ok'], timeoutMs: 1 }),
    '超时容忍',
  );
  check('超时注入（timeoutMs=1）下返回结构仍完整且不为 undefined',
    typeof s.available === 'boolean' && REASONS.includes(s.reason), `reason=${s.reason}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ④ ok：两项探测都通过
// ─────────────────────────────────────────────────────────────────────────────
{
  const s = wellFormed(
    linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => FAKE['always-ok'] }),
    'ok',
  );
  check("ok：两项探测都通过 ⇒ reason === 'ok' 且 available === true",
    s.reason === 'ok' && s.available === true, `实际 ${s.reason}/${s.available}`);
  check('ok：detail 带上版本号与通过的探测命令（可复核）',
    /0\.8\.0/.test(s.detail) && /--unshare-all/.test(s.detail), s.detail.slice(0, 100));
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 静态口径（probe:false）：不跑子进程，只判平台 + 二进制存在
// ─────────────────────────────────────────────────────────────────────────────
{
  const s = linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => '/usr/bin/bwrap', probe: false });
  check('probe:false：只判平台 + 二进制存在，不跑 --version（缺文件也不报 broken）',
    s.available === true && s.reason === 'ok', `实际 ${s.reason}/${s.available}`);
  check('probe:false：detail 明确标注是静态判定（不谎称已验证隔离）',
    /静态/.test(s.detail), s.detail.slice(0, 80));
  const miss = linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => null, probe: false });
  check('probe:false：二进制缺失时仍是 bwrap-missing', miss.reason === 'bwrap-missing' && !miss.available,
    `实际 ${miss.reason}/${miss.available}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ 回归门禁：linuxSandboxAvailable() 行为**保持不变**（静态口径）
//   — 等价于 test/sandbox-crossplatform.test.js:44 的断言，此处再钉一次防止有人
//     把它改成 probe 版而引入每次 exec 两次 fork+exec 的性能回归。
// ─────────────────────────────────────────────────────────────────────────────
{
  const expectStatic = process.platform === 'linux' && !!linux.findBwrap();
  check('linuxSandboxAvailable() 返回值 === 历史静态口径（platform==="linux" && !!findBwrap()）',
    linux.linuxSandboxAvailable() === expectStatic,
    `实际=${linux.linuxSandboxAvailable()} 期望=${expectStatic}（platform=${process.platform}）`);
  check('linuxSandboxAvailable() 返回严格布尔（不是对象/undefined）',
    typeof linux.linuxSandboxAvailable() === 'boolean', typeof linux.linuxSandboxAvailable());
  check('linuxSandboxAvailable() === linuxSandboxStatus({probe:false}).available（同源不漂移）',
    linux.linuxSandboxAvailable()
    === linux.linuxSandboxStatus({ probe: false }).available,
    `两处一致`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑦ 本机真实调用（不带任何注入）——验收要求：darwin 上必须 not-linux
// ─────────────────────────────────────────────────────────────────────────────
{
  const s = wellFormed(linux.linuxSandboxStatus(), '本机真实调用');
  console.log(`\n本机实际探测结果：reason=${s.reason} available=${s.available}`);
  console.log(`  detail: ${s.detail}`);
  console.log(`  hint  : ${s.hint}\n`);
  if (process.platform !== 'linux') {
    check(`本机（${process.platform}）真实调用：reason === 'not-linux' 且 available === false`,
      s.reason === 'not-linux' && s.available === false, `实际 ${s.reason}/${s.available}`);
  } else {
    check('本机（linux）真实调用：reason 落在枚举内且 available ⟺ ok',
      REASONS.includes(s.reason) && s.available === (s.reason === 'ok'), `实际 ${s.reason}/${s.available}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑧ 自检：四值枚举每一个都真的可达（防「某分支写了但永远走不到」= 假分支）
// ─────────────────────────────────────────────────────────────────────────────
{
  const reached = new Set([
    linux.linuxSandboxStatus({ platform: 'darwin' }).reason,
    linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => null }).reason,
    linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => FAKE['version-ok'] }).reason,
    linux.linuxSandboxStatus({ platform: 'linux', findBwrap: () => FAKE['always-ok'] }).reason,
  ]);
  check('自检：四个 reason 分支全部可达（否则某分支＝死代码，诊断仍有盲区）',
    REASONS.every((r) => reached.has(r)), `到达=${[...reached].join(',')}`);
}

// 清理临时假 bwrap
try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\nsandbox-linux-status: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);

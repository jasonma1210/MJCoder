// X22 收尾门禁：beta 通道更新元数据链路（tag → channel → <channel>.yml）
//
// 问题本体（为什么需要这条链路）：
//   修复前 CI 只产出 latest.yml，从不产出 beta 通道的更新描述文件。于是「发一个 beta
//   让部分用户先升」在物理上无法执行——beta 安装包传上去了，客户端拿不到 beta 的
//   更新描述，electron-updater 在 beta 通道查更新必然 not found。灰度能力为 0 的根因
//   在发布侧，不在客户端（X22 前半部分修的是客户端的 allowPrerelease / 降级开关）。
//
// 本套件钉住四件事，缺任何一件 beta 灰度就会再次静默失效：
//   1. tag → channel 的映射（含 fail-closed：非法 tag 必须抛错，不得回落 latest）；
//   2. package.json 的通道相关字段存在、类型正确、且**位置**正确（build 顶级，不在 publish 内）；
//   3. CI 真的引用了 resolve-update-channel.mjs 并把通道传给 electron-builder
//      （防以后有人改 YAML 把通道逻辑丢掉——那种改动不会让任何别的测试变红）；
//   4. X22 前半部分不被回退：updater 里「非 latest 通道必须 allowPrerelease」仍在。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { resolveUpdateChannel } from '../scripts/resolve-update-channel.mjs';

const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.dirname(DESKTOP);
const read = (p) => fs.readFileSync(p, 'utf8');

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

const pkg = JSON.parse(read(path.join(DESKTOP, 'package.json')));
const ci = read(path.join(REPO, '.github/workflows/ci.yml'));
const updaterSrc = read(path.join(DESKTOP, 'main/updater/index.js'));

// CI 的可执行行（去掉整行 YAML 注释）：源码级断言只看真正会跑的 shell，
// 免得文档注释里提到某个旧写法就把门禁弄红（那会诱使人删注释而非改回正确实现）。
const ciCode = ci
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

// ── 1) tag → channel 映射（唯一事实来源）──
check('稳定 tag → latest / release / prerelease=false', () => {
  for (const tag of ['v0.1.0', '0.1.0', 'v1.2.3', 'v10.20.30']) {
    const r = resolveUpdateChannel(tag);
    assert.equal(r.channel, 'latest', `${tag} → channel`);
    assert.equal(r.releaseType, 'release', `${tag} → releaseType`);
    assert.equal(r.prerelease, false, `${tag} → prerelease`);
  }
});

check('预发布 tag → beta / prerelease / prerelease=true（rc/beta/alpha 都归 beta 通道）', () => {
  for (const tag of ['v0.1.0-rc.1', 'v0.2.0-beta.3', '0.1.0-alpha.1', 'v1.0.0-rc.10']) {
    const r = resolveUpdateChannel(tag);
    assert.equal(r.channel, 'beta', `${tag} → channel（客户端只有 latest/beta 两档，rc 也必须归 beta）`);
    assert.equal(r.releaseType, 'prerelease', `${tag} → releaseType`);
    assert.equal(r.prerelease, true, `${tag} → prerelease`);
  }
});

check('version 去掉 v 前缀且保留预发布段（npm version 与文件名都依赖它）', () => {
  assert.equal(resolveUpdateChannel('v0.1.0').version, '0.1.0');
  assert.equal(resolveUpdateChannel('0.1.0').version, '0.1.0');
  assert.equal(resolveUpdateChannel('v0.2.0-beta.3').version, '0.2.0-beta.3');
  assert.equal(resolveUpdateChannel('v0.1.0-rc.1').version, '0.1.0-rc.1');
});

check('首尾空白被容忍（tag 从 env/CLI 传来时常带换行）', () => {
  assert.equal(resolveUpdateChannel(' v0.1.0\n').channel, 'latest');
});

// ── 2) fail-closed：非法 tag 一律抛错，绝不回落 latest ──
// 这条是整个设计的安全阀。回落 latest 意味着「把预发布当稳定版推给所有用户」，
// 客户端装上后无法自行回退（需 MJ_ALLOW_DOWNGRADE=1 手动干预）——不可逆。
// 而「这次没发出去」重打 tag 即可。方向不对称，所以只能 fail-closed。
check('非法 tag 一律抛错（不静默回落 latest）', () => {
  const bad = ['', '   ', 'v', 'vfoo', 'latest', '1.0', 'v1', 'v1.0.0.0', 'release-1.0.0',
    'v1.0.0-', 'v01.0.0', 'v1.0.0-rc.01', 'nightly', null, undefined, 42, {}];
  for (const tag of bad) {
    assert.throws(
      () => resolveUpdateChannel(tag),
      `非法 tag ${JSON.stringify(tag)} 必须抛错（否则会被当成稳定版推给所有用户）`,
    );
  }
});

check('抛出的错误信息带可行动线索（能直接看出该改 tag）', () => {
  assert.throws(() => resolveUpdateChannel('v'), /semver|tag/i);
  assert.throws(() => resolveUpdateChannel(''), /空|semver|tag/i);
});

// ── 3) package.json：通道相关配置的存在性 + 类型 + 位置 ──
check('build.publish.channel / releaseType 存在且类型正确', () => {
  assert.equal(typeof pkg.build?.publish?.channel, 'string', 'publish.channel 必须是字符串');
  assert.ok(['latest', 'beta'].includes(pkg.build.publish.channel),
    `publish.channel 应为 latest 或 beta，实际 ${JSON.stringify(pkg.build?.publish?.channel)}`);
  assert.ok(['release', 'prerelease', 'draft'].includes(pkg.build?.publish?.releaseType),
    `publish.releaseType 非法：${JSON.stringify(pkg.build?.publish?.releaseType)}`);
});

// 位置断言（防包爆炸）：generateUpdatesFilesForAllChannels 是 **build 顶级** 字段。
// 放进 build.publish 会被 electron-builder 25 的 schema 拒绝（GithubOptions.additionalProperties=false），
// 后果是 `npm run build` 整个跑不起来，而只查 mac/win/linux 的旧断言看不见（测试绿、打包红）。
check('generateUpdatesFilesForAllChannels 在 build 顶级且为 true（不在 publish 内）', () => {
  assert.equal(pkg.build?.generateUpdatesFilesForAllChannels, true,
    '缺少 build.generateUpdatesFilesForAllChannels: true（beta 通道 yml 产出开关）');
  assert.ok(!('generateUpdatesFilesForAllChannels' in (pkg.build?.publish || {})),
    '该字段被放进 build.publish —— schema 不接受（GithubOptions.additionalProperties=false），打包会失败');
});

// ── 4) 源码级断言：CI 真的接线了（防「改 YAML 丢掉通道逻辑」且无测试变红）──
check('CI 引用了 resolve-update-channel.mjs（通道由 tag 解析，不是手写）', () => {
  assert.match(ci, /scripts\/resolve-update-channel\.mjs/,
    'ci.yml 未引用 scripts/resolve-update-channel.mjs —— beta 通道解析链路断了');
});

check('CI 把解析结果传给 electron-builder（-c.publish.channel / releaseType）', () => {
  assert.match(ci, /-c\.publish\.channel=/, 'ci.yml 未传 -c.publish.channel：产物永远是 latest.yml，beta 灰度无法执行');
  assert.match(ci, /-c\.publish\.releaseType=/, 'ci.yml 未传 -c.publish.releaseType：beta 版会发成正式 Release');
});

check('CI 显式开启 generateUpdatesFilesForAllChannels（-c. 顶级路径）', () => {
  assert.match(ci, /-c\.generateUpdatesFilesForAllChannels=true/,
    'ci.yml 未传 -c.generateUpdatesFilesForAllChannels=true');
  // 防错层级：-c.publish.generateUpdatesFilesForAllChannels 会被 schema 拒绝
  assert.ok(!/-c\.publish\.generateUpdatesFilesForAllChannels/.test(ci),
    '误写成 -c.publish.generateUpdatesFilesForAllChannels —— 该字段不是 publish 子字段，打包会失败');
});

check('CI 的 npm version 用脚本解析出的 VERSION（不再手写去 v 前缀的截断写法）', () => {
  assert.match(ciCode, /npm version "\$VERSION"/,
    'npm version 未使用脚本解析出的 $VERSION');
  // 只看可执行行：注释里提到旧写法是合法的文档说明
  assert.ok(!/\$\{GITHUB_REF_NAME#v\}/.test(ciCode),
    '可执行行仍在手写 ${GITHUB_REF_NAME#v}：与通道解析脱钩，两处容易走偏');
});

check('CI 的 tag 解析是 fail-closed（显式判退出码，不用裸 eval 吞错）', () => {
  // `eval "$(cmd)"` 在 cmd 失败时会 eval 空串并返回 0，等于把非法 tag 静默放行。
  assert.ok(!/eval "\$\(node scripts\/resolve-update-channel\.mjs/.test(ciCode),
    '直接用 eval "$(node ...)" 会在解析失败时静默放行——必须先捕获并判退出码');
  assert.match(ciCode, /CHANNEL_INFO=/, '缺少显式捕获退出码的中间变量（fail-closed 需要）');
});

check('CI 制品名带通道（区分 latest / beta 产物）', () => {
  assert.match(ci, /MJCode-\$\{\{ matrix\.os \}\}-\$\{\{ steps\.channel\.outputs\.channel \}\}-\$\{\{ github\.sha \}\}/,
    'artifact 名未带通道，同 sha 下 stable/beta 产物无法区分');
});

check('CI 制品清单仍收集 *.yml（beta.yml 才能真正被上传）', () => {
  assert.match(ci, /desktop\/release\/\*\.yml/,
    'artifact path 未包含 *.yml：即使产出了 beta.yml 也不会被上传');
});

// ── 5) 一致性：X22 前半部分不许被回退 ──
// 只有 channel 没有 allowPrerelease 时，GitHub provider 默认只认正式 Release，
// beta 通道实际上永远「已是最新」——这正是当初 X22 被开单的原因。
check('updater：非 latest 通道仍设 allowPrerelease=true（X22 前半部分未被回退）', () => {
  assert.match(updaterSrc, /UPDATE_CHANNEL !== 'latest'/,
    'updater 丢了「非 latest 通道」判断');
  assert.match(updaterSrc, /autoUpdater\.allowPrerelease = true/,
    'updater 丢了 allowPrerelease=true —— beta 通道会永远「已是最新」');
});

check('updater：降级仍需显式开关（默认不允许，防 metadata 把用户静默回退）', () => {
  assert.match(updaterSrc, /MJ_ALLOW_DOWNGRADE === '1'/,
    '降级开关被改动/移除：默认允许降级会让坏 metadata 静默回退用户');
  assert.match(updaterSrc, /autoUpdater\.allowDowngrade = true/);
});

console.log(`\nupdate-channel: ${pass}/${total} 通过`);
if (pass !== total) process.exitCode = 1;

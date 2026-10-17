#!/usr/bin/env node
// X22 收尾：从 git tag 解析「更新通道」与「GitHub Release 类型」。
//
// 为什么需要这个脚本（问题本体）：
//   修复前 CI 只产出 latest.yml，从不产出 beta 通道的更新描述文件。于是「发一个 beta
//   让部分用户先升」在物理上无法执行——beta 包传上去了，客户端拿不到 beta 的更新描述，
//   electron-updater 在 beta 通道查更新必然 not found。灰度为 0 的原因不在客户端，
//   而在发布侧从来没有产出过 beta.yml。
//
// 设计原则：**fail-closed**。
//   tag 形态无法判定时一律抛错，绝不静默回落成 latest。原因是回落方向是单向危险：
//   把预发布当稳定版推给**所有**用户是不可逆的（客户端装上后只能靠降级开关回退），
//   而「这次没发出去」可以重打 tag 重试。宁可不发布，也不能推错通道。
//
// 映射规则（唯一事实来源，改动须同步 desktop/test/update-channel.test.mjs）：
//   v0.1.0 / 0.1.0                  → channel=latest,  releaseType=release,    prerelease=false
//   v0.1.0-rc.1 / v0.2.0-beta.3     → channel=beta,    releaseType=prerelease, prerelease=true
//   0.1.0-alpha.1（无 v 前缀，容忍） → channel=beta,    releaseType=prerelease, prerelease=true
//
// 用法（CI）：
//   eval "$(node scripts/resolve-update-channel.mjs "$GITHUB_REF_NAME")"
//   → 得到 shell 变量 CHANNEL / RELEASE_TYPE / VERSION
//   同时（若 $GITHUB_ENV 存在）把同样三行追加进 GITHUB_ENV，供**后续 step** 使用。
//   注意：GITHUB_ENV 对写入它的**同一个 step** 不生效，所以本 step 内仍需靠 eval 取变量。
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 严格 semver（https://semver.org）：major.minor.patch[-prerelease][+build]
// 数字段禁止前导零（`01.0.0` 不是合法 semver），因此每段写作 (0|[1-9]\d*)。
const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const STABLE = Object.freeze({ channel: 'latest', releaseType: 'release', prerelease: false });
const PRERELEASE = Object.freeze({ channel: 'beta', releaseType: 'prerelease', prerelease: true });

/**
 * 把 tag 解析成更新通道信息。非法输入抛错（fail-closed，不回落 latest）。
 *
 * @param {string} tag 形如 `v0.1.0` / `v0.1.0-rc.1` / `0.2.0-beta.3`
 * @returns {{version: string, channel: 'latest'|'beta', releaseType: 'release'|'prerelease', prerelease: boolean}}
 */
export function resolveUpdateChannel(tag) {
  if (typeof tag !== 'string') {
    throw new Error(`tag 必须是字符串，收到 ${tag === null ? 'null' : typeof tag}`);
  }
  const raw = tag.trim();
  if (raw === '') {
    throw new Error('tag 为空：无法判定更新通道（拒绝回落 latest）');
  }

  const m = SEMVER_RE.exec(raw);
  if (!m) {
    throw new Error(
      `tag 不是合法的 semver：${JSON.stringify(tag)}`
        + '（期望 v0.1.0 或 v0.1.0-rc.1 形态；拒绝回落 latest——把预发布推成稳定版不可逆）',
    );
  }

  const [, , , , prereleasePart] = m;
  // semver 4.3.1：numeric identifier 不得含前导零（`-rc.01` 非法）。
  // 这里显式拦掉，避免 npm version / 客户端版本比较出现 "01" 与 "1" 被当成不同版本。
  if (prereleasePart != null) {
    for (const id of prereleasePart.split('.')) {
      if (/^\d+$/.test(id) && id.length > 1 && id.startsWith('0')) {
        throw new Error(`tag 的预发布段含前导零：${JSON.stringify(tag)}（semver 非法，如 -rc.01）`);
      }
    }
  }

  // version 去掉 `v` 前缀，保留原始长度与大小写（semver 中有意义的部分不做改写）。
  const version = raw.startsWith('v') ? raw.slice(1) : raw;
  const hasPrerelease = prereleasePart != null;
  const mapping = hasPrerelease ? PRERELEASE : STABLE;

  return {
    version,
    channel: mapping.channel,
    releaseType: mapping.releaseType,
    prerelease: mapping.prerelease,
  };
}

// ── CLI ──
// stdout 只输出三行 `KEY=VALUE`（供 CI `eval`），任何诊断信息一律走 stderr，
// 避免被 eval 当成代码执行。
function cliMain(argv) {
  let resolved;
  try {
    resolved = resolveUpdateChannel(argv[2]);
  } catch (err) {
    console.error(`[resolve-update-channel] ${err.message}`);
    console.error('[resolve-update-channel] fail-closed：不产出通道信息，中止本次发布。请修正 tag 后重新打标签。');
    return 1;
  }

  const lines = [
    `CHANNEL=${resolved.channel}`,
    `RELEASE_TYPE=${resolved.releaseType}`,
    `VERSION=${resolved.version}`,
  ];

  // 三行均为 `KEY=裸值`。值域已被上面严格限死（semver 字符集 [0-9A-Za-z.+-]），
  // 不含 sh 元字符，故 `eval` 安全；不加引号是为了让 GITHUB_ENV 与 shell 两种消费方格式一致。
  for (const line of lines) process.stdout.write(`${line}\n`);

  // GITHUB_ENV：给后续 step 用（写成裸 `KEY=VALUE` 行，不能带引号，否则引号会进值里）。
  const githubEnvPath = process.env.GITHUB_ENV;
  if (githubEnvPath) {
    try {
      fs.appendFileSync(githubEnvPath, `${lines.join('\n')}\n`, 'utf8');
    } catch (err) {
      console.error(`[resolve-update-channel] 写入 GITHUB_ENV 失败：${err.message}`);
      return 1;
    }
  }

  console.error(
    `[resolve-update-channel] tag=${JSON.stringify(argv[2])} → channel=${resolved.channel}`
      + ` releaseType=${resolved.releaseType} version=${resolved.version}`,
  );
  return 0;
}

// 仅在「被直接执行」时跑 CLI；被 import（测试/复用）时零副作用。
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // realpath 失败（如 entry 不存在于本机）时退回 href 比较
    return pathToFileURL(entry).href === import.meta.url;
  }
})();

if (invokedDirectly) {
  process.exitCode = cliMain(process.argv);
}

// D-13 门禁：审批档/沙箱档的**数据单源**（shared/rolePolicyData.json）+ 双薄壳一致性。
//
// 背景：desktop 有两条通道要同一套「取更严者」纪律 ——
//   左（CJS，Electron 主进程）：main/approvalPolicy.js
//   右（ESM，Vite 打包进渲染层）：shared/roleClamp.mjs
// 两侧**不能**合成同一个文件，这条路已被评估并否决（.mjs 无法被 CJS 同步 require，而钳制必须在
// 组装 engineParams 的同一同步栈完成；反向改 .cjs 要动 5 个消费方并触及审批/沙箱安全路径）。
// 详见 shared/roleClamp.mjs 文件头的「历史附录」。
//
// 于是收敛到能做到的那一层：**会漂移的值只留一份数据**（rolePolicyData.json），两侧只剩
// 「读数据 + 查表」的薄壳，本门禁锁死五件事：
//   1. 单源 + 契约冻结：JSON 的值 == 本文件冻结的期望值 == 左壳 == 右壳；且两侧源码里**不再有
//      档位→序号的字面量**。契约那一份是**故意**冗余的：两壳读同一份 JSON，只改 JSON 会让两侧
//      一起变、对账照样绿 —— 严格序被静默改反就无人拦（实测过），必须另有一份可 review 的期望。
//   2. 覆盖：JSON 里每个档位两侧都认（不是某一侧的白名单漏项），且严格序按 JSON 的数值生效。
//   2b. 推导值单源：hostPolicySnapshot（cwd→沙箱档，**唯一随组落盘**的出口）的两个值必须来自
//      JSON 的 snapshot 段、返回值 ∈ SANDBOX_ORDER、审批档真归一化；并写死「渲染层刻意没有这个
//      函数」——否则下一轮会把有意的非对称当成漏搬项，为「对称」补出一份冗余副本。
//   2c. 推导值单点：sandboxTierForCwd 是 cwd→沙箱档的**唯一判定**，hostPolicySnapshot 与
//      main/main.js 定时通道（无人值守那条）都复用它；main.js 不得残留裸档名，且必须真接线。
//   2d. 派生表达式棘轮：`cwd ? 'workspace-write' : 'read-only'` 这个手抄体在 approvalPolicy /
//      main / workerPool 必须 0 处，exec.js 走 allow-list 恰好 2 处（800 软档余 0 行，改它须先抽模块）。
//   3. 缺失即红：JSON 缺 approval/sandbox/snapshot、或坏成非法 JSON → 立刻报错，**不许**默认空
//      对象兜底；schemaVersion 另有棘轮锁值（必须是 1，改版本得同批改门禁）。
//   4. 自检：本门禁的比较器本身要被变异测试验过（改一个数值必须红，恢复必须绿），防恒真门禁。
//   5. 契约不外泄：生产代码不得出现标识符 CONTRACT（断言 1 防「值」漏回代码，这条防「契约本身」
//      漏回代码 —— 契约一旦被生产代码引用，就成了第四份事实源，还是自带「经评审」光环、
//      再没人核对的那种）。
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 右壳（ESM）：与渲染层 import 的是同一份，能加载即证明 JSON import 在 Node ESM 侧可用
import * as esmShell from '../shared/roleClamp.mjs';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 左壳（CJS）：ESM import CJS 时 default 即 module.exports
const cjsShell = require('../main/approvalPolicy.js');

const DATA_FILE = 'shared/rolePolicyData.json';
const DATA_PATH = path.join(DESKTOP, DATA_FILE);

// 契约冻结（**故意**在门禁里再写一遍值）：JSON 是运行时唯一出处，但「严格序本身」是安全契约 ——
// 把 always 的序号改小、或把 on-request 抬到最高，会让「哪档更严」静默反转，而两壳因为读同一份
// 数据会**一起变**，光靠「JSON ↔ 两壳对账」根本发现不了（实测过：只改 JSON 时那道断言仍然绿）。
// 所以这里冻结一份经评审的期望值：要改严格序，必须同批改这里 —— 让变更出现在 review diff 里，
// 而不是藏在数据文件的一个数字里。
const CONTRACT = {
  approval: { order: { never: 0, 'auto-safe': 1, 'on-request': 2, always: 3 }, default: 'on-request' },
  sandbox: { order: { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 }, default: 'workspace-write' },
  // 推导值也冻在这儿：withoutCwd 从 read-only 改成别档（哪怕仍是合法档，比如 full-access）不会被
  // 上面的 order 比较发现，却会**静默放开无目录场景的权限** —— 与「严格序被改反」同一类风险。
  snapshot: { withCwd: 'workspace-write', withoutCwd: 'read-only' },
};

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: 期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);
}
function mustThrow(fn, what) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error(`${what}：本应报错却静默通过（门禁失效）`);
}
// 剥注释后再做结构断言：否则「把字面量注释掉」也照样匹配（假绿）。
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += d === undefined ? '' : d; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1; continue;
    }
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2; continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; out += c; i += 1; continue; }
    out += c; i += 1;
  }
  return out;
}
function readCode(rel) {
  const p = path.join(DESKTOP, rel);
  if (!fs.existsSync(p)) throw new Error(`文件不存在：${rel}`);
  return stripComments(fs.readFileSync(p, 'utf8'));
}
// 键序无关的逐值比较（JSON 键序不是契约，值才是）
function sameOrder(actual, expected, what) {
  if (actual === null || typeof actual !== 'object') throw new Error(`${what}：实得 ${JSON.stringify(actual)} 不是对象`);
  const ak = Object.keys(actual).sort();
  const ek = Object.keys(expected).sort();
  if (ak.join('\u0000') !== ek.join('\u0000')) {
    throw new Error(`${what}：档位集合不一致 —— 实得 [${ak}] vs 期望 [${ek}]`);
  }
  for (const k of ek) eq(actual[k], expected[k], `${what}["${k}"]`);
}

// ── 数据文件的形状校验：缺键即抛，绝不兜底成 {} ──────────────────────────
// 这条校验就是「缺失即红」的本体：调用方（断言 1 / 断言 4）都先过它。
function assertDataShape(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error(`${DATA_FILE}：内容不是对象`);
  for (const side of ['approval', 'sandbox']) {
    const part = d[side];
    if (!part || typeof part !== 'object') {
      throw new Error(`${DATA_FILE}：缺少 "${side}" 段（不允许默认空对象兜底，两侧会静默按空表比较）`);
    }
    if (!part.order || typeof part.order !== 'object' || Object.keys(part.order).length === 0) {
      throw new Error(`${DATA_FILE}：缺少 "${side}.order" 或为空表`);
    }
    if (typeof part.default !== 'string') {
      throw new Error(`${DATA_FILE}：缺少 "${side}.default"`);
    }
    if (part.order[part.default] == null) {
      throw new Error(`${DATA_FILE}："${side}.default"=${JSON.stringify(part.default)} 不在 "${side}.order" 内（归一化会指向不存在的档位）`);
    }
  }
  // snapshot 段：hostPolicySnapshot 的 cwd→沙箱档推导值也必须来自 JSON（那是唯一随组落盘的出口）
  const snap = d.snapshot;
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) {
    throw new Error(`${DATA_FILE}：缺少 "snapshot" 段（cwd→沙箱档的推导值不允许再写死在代码里）`);
  }
  for (const k of ['withCwd', 'withoutCwd']) {
    const v = snap[k];
    if (typeof v !== 'string') throw new Error(`${DATA_FILE}：缺少 "snapshot.${k}"`);
    if (d.sandbox.order[v] == null) {
      throw new Error(`${DATA_FILE}："snapshot.${k}"=${JSON.stringify(v)} 不是 "sandbox.order" 里的合法档位（会把一个不存在的档位随组快照落盘）`);
    }
  }
}

// ── 单源比较器（断言 1 用它，断言 4 对它做变异测试）────────────────────────
function assertSingleSource(d, cjs, esm) {
  assertDataShape(d);
  // (i) 契约冻结：JSON 的值必须等于经评审的期望（改严格序 = 改安全契约，得显式改这里）
  sameOrder(d.approval.order, CONTRACT.approval.order, 'JSON 审批严格序 vs 契约期望');
  sameOrder(d.sandbox.order, CONTRACT.sandbox.order, 'JSON 沙箱严格序 vs 契约期望');
  eq(d.approval.default, CONTRACT.approval.default, 'JSON DEFAULT_APPROVAL vs 契约期望');
  eq(d.sandbox.default, CONTRACT.sandbox.default, 'JSON DEFAULT_SANDBOX vs 契约期望');
  eq(d.snapshot.withCwd, CONTRACT.snapshot.withCwd, 'JSON snapshot.withCwd vs 契约期望');
  eq(d.snapshot.withoutCwd, CONTRACT.snapshot.withoutCwd, 'JSON snapshot.withoutCwd vs 契约期望');
  // (ii) 数据单源：两壳读到的就是 JSON 这一份
  sameOrder(cjs.APPROVAL_ORDER, d.approval.order, '左壳 APPROVAL_ORDER vs JSON');
  sameOrder(esm.APPROVAL_ORDER, d.approval.order, '右壳 APPROVAL_ORDER vs JSON');
  sameOrder(cjs.SANDBOX_ORDER, d.sandbox.order, '左壳 SANDBOX_ORDER vs JSON');
  sameOrder(esm.SANDBOX_ORDER, d.sandbox.order, '右壳 SANDBOX_ORDER vs JSON');
  eq(cjs.DEFAULT_APPROVAL, d.approval.default, '左壳 DEFAULT_APPROVAL');
  eq(esm.DEFAULT_APPROVAL, d.approval.default, '右壳 DEFAULT_APPROVAL');
  eq(cjs.DEFAULT_SANDBOX, d.sandbox.default, '左壳 DEFAULT_SANDBOX');
  eq(esm.DEFAULT_SANDBOX, d.sandbox.default, '右壳 DEFAULT_SANDBOX');
}

const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

// ── 1. 数据单源：值只在 JSON 里写一次（运行时），契约另冻结在门禁里 ──────────
check('1 数据单源：JSON 的 order/default == 契约期望 == 左(CJS)/右(ESM)两壳，且两壳不再有「档位: 序号」字面量', () => {
  // 缺口 C（正钉，非抛错型）：schemaVersion 必须被锁值。此前它只出现在 assertDataShape 的**负例**
  // 探测里（{schemaVersion:1} 缺 approval 才抛），把它改成 2 不会红 —— 等于版本号没人管。
  // 改版本时同批改这里（与 REFERENCE_COUNT_BASELINE / BASELINE_800 同一种棘轮纪律）。
  const schemaVersionOk = data.schemaVersion === 1;
  if (!schemaVersionOk) throw new Error(`schemaVersion 期望 1（棘轮锁值），实际 ${JSON.stringify(data.schemaVersion)}`);

  assertSingleSource(data, cjsShell, esmShell);

  // 值必须真的搬进了 JSON：壳里残留字面量 = 又出现第二处可漂移的源（注释里提不算）
  const shells = { 'main/approvalPolicy.js': readCode('main/approvalPolicy.js'), 'shared/roleClamp.mjs': readCode('shared/roleClamp.mjs') };
  for (const [rel, src] of Object.entries(shells)) {
    for (const [side, part] of Object.entries({ approval: data.approval, sandbox: data.sandbox })) {
      for (const [tier, idx] of Object.entries(part.order)) {
        const lit = new RegExp(`['"]?${tier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*:\\s*${idx}\\b`);
        if (lit.test(src)) throw new Error(`${rel} 里仍有字面量「${tier}: ${idx}」—— 值必须只写在 ${DATA_FILE}`);
      }
    }
  }
});

// ── 2. 覆盖：JSON 里的每个档位两侧都认，严格序按 JSON 数值生效 ──────────────
check('2 新字段覆盖：JSON 每个档位两侧都能处理（不是某一侧的白名单漏项），多档位严格序与数值一致', () => {
  // (a) 每个档位都必须被两侧识别成「自己」，而不是被归一化吞成默认档
  for (const tier of Object.keys(data.approval.order)) {
    eq(cjsShell.normalizeApprovalMode(tier), tier, `左壳认不出审批档 ${tier}`);
    eq(esmShell.normalizeApprovalMode(tier), tier, `右壳认不出审批档 ${tier}`);
  }
  for (const tier of Object.keys(data.sandbox.order)) {
    eq(cjsShell.normalizeSandboxPolicy(tier), tier, `左壳认不出沙箱档 ${tier}`);
    eq(esmShell.normalizeSandboxPolicy(tier), tier, `右壳认不出沙箱档 ${tier}`);
  }
  // (b) 严格序真的按 JSON 的数值走（不依赖代码里残留的次序）：两侧、双向都要成立
  const approvals = Object.keys(data.approval.order);
  for (const a of approvals) {
    for (const b of approvals) {
      if (a === b) continue;
      const expected = data.approval.order[a] > data.approval.order[b] ? a : b;
      eq(cjsShell.stricterApproval(a, b), expected, `左壳 stricterApproval(${a},${b})`);
      eq(esmShell.stricterApproval(a, b), expected, `右壳 stricterApproval(${a},${b})`);
    }
  }
  const sandboxes = Object.keys(data.sandbox.order);
  for (const a of sandboxes) {
    for (const b of sandboxes) {
      if (a === b) continue;
      const expected = data.sandbox.order[a] < data.sandbox.order[b] ? a : b;
      eq(cjsShell.stricterSandbox(a, b), expected, `左壳 stricterSandbox(${a},${b})`);
      eq(esmShell.stricterSandbox(a, b), expected, `右壳 stricterSandbox(${a},${b})`);
    }
  }
  // (c) 两侧不得有 JSON 之外的额外档位（多出来的档位 = 单侧白名单，同样会漂移）
  sameOrder(cjsShell.APPROVAL_ORDER, data.approval.order, '左壳审批档位集合');
  sameOrder(esmShell.APPROVAL_ORDER, data.approval.order, '右壳审批档位集合');
  sameOrder(cjsShell.SANDBOX_ORDER, data.sandbox.order, '左壳沙箱档位集合');
  sameOrder(esmShell.SANDBOX_ORDER, data.sandbox.order, '右壳沙箱档位集合');
});

// ── 2b. 推导值单源：hostPolicySnapshot（唯一随组落盘的出口）─────────────────
// 缺口 B：这个函数此前在两个门禁里**各 0 次引用**。4 条断言覆盖的是 ORDER/DEFAULT/normalize，
// 而真正产出持久化「宿主治理快照」的它没人看 —— 于是「数据单源」可以在 :93 那一行字面量上断掉
// 而门禁全绿。快照落盘后 Worker 直接读，写进一个不存在的档位比功能失效更难查。
check('2b 推导值单源：hostPolicySnapshot 的 cwd→沙箱映射来自 JSON、返回值合法、审批档真归一化，且 ESM 侧刻意没有它', () => {
  const withCwd = cjsShell.hostPolicySnapshot('/tmp/some-project', 'always');
  const withoutCwd = cjsShell.hostPolicySnapshot('', 'never');

  // B-1 / B-2：映射逐值来自 JSON（改 JSON 档名 → 这里跟着变；写死字面量 → 立刻红）
  eq(withCwd.sandboxPolicy, data.snapshot.withCwd, 'B-1 有 cwd 时的沙箱档应等于 JSON snapshot.withCwd');
  eq(withoutCwd.sandboxPolicy, data.snapshot.withoutCwd, 'B-2 无 cwd 时的沙箱档应等于 JSON snapshot.withoutCwd');

  // B-3：两个返回值都必须是两侧都认定的合法档位（同时挡住「JSON 里写非法名」与「代码里写死旧名」）
  for (const [what, out] of Object.entries({ '有 cwd': withCwd, '无 cwd': withoutCwd })) {
    if (data.sandbox.order[out.sandboxPolicy] == null) {
      throw new Error(`B-3 ${what} 时返回非法沙箱档 ${JSON.stringify(out.sandboxPolicy)} —— 不存在的档位会随组快照落盘`);
    }
    if (cjsShell.SANDBOX_ORDER[out.sandboxPolicy] !== data.sandbox.order[out.sandboxPolicy]) {
      throw new Error(`B-3 ${what} 时档位 ${out.sandboxPolicy} 在左壳与 JSON 的序号不一致`);
    }
  }
  // 语义带宽：两种 cwd 必须给出**不同**档位。若被改成同值（例如都 workspace-write），
  // 上面三条仍全绿，但「无目录 → 只读」的意图已被静默放弃（放宽方向）。
  if (withCwd.sandboxPolicy === withoutCwd.sandboxPolicy) {
    throw new Error(`B-3 两种 cwd 产出了同一沙箱档 ${withCwd.sandboxPolicy} —— 无目录场景的只读意图被静默放弃（属放宽权限）`);
  }

  // B-4：审批档确实过归一化，不是原样透传（这条与 V12 同纪律）
  eq(cjsShell.hostPolicySnapshot('/tmp/x', 'bogus-tier').approvalMode, data.approval.default, 'B-4 非法审批档必须收敛到 JSON 的默认档');
  eq(cjsShell.hostPolicySnapshot('/tmp/x', 'always').approvalMode, 'always', 'B-4 合法审批档不得被改写');

  // B-5：ESM 侧**有意**没有这个函数。这条不是「漏搬项」，写死它是为了防止下一个人为了「对称」
  // 在渲染层派生一份用不到的副本 —— 那会把刚消掉的重复又造回来。
  if (esmShell.hostPolicySnapshot !== undefined) {
    throw new Error('B-5 渲染层（roleClamp.mjs）不应有 hostPolicySnapshot —— 渲染层只做钳制，不产出编排建组快照；这是有意的非对称，不要为「对称」补副本');
  }

  // D：薄壳里不得再残留裸沙箱档名字面量（A 的收尾验证；注释里提不算，readCode 已剥注释）
  const src = readCode('main/approvalPolicy.js');
  for (const tier of Object.keys(data.sandbox.order)) {
    const lit = new RegExp(`['"\`]${tier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
    if (lit.test(src)) {
      throw new Error(`D main/approvalPolicy.js 里仍有裸沙箱档名字面量「${tier}」—— 档名必须只来自 ${DATA_FILE} 的 snapshot/order`);
    }
  }
});

// ── 2c. 推导值单点：sandboxTierForCwd（两处调用方共享同一判定）──────────────
// 缺口 D（第四处手抄）：`cwd → 沙箱档` 原本有**两份实现** —— 本文件的 hostPolicySnapshot 与
// main/main.js:1133 的定时通道各抄一遍同款三元判定。定时通道是「无人值守、没人看着」的那条，
// 只改前者会让它在 JSON 改档名后继续用旧名，而所有门禁照样绿。现在两处都走这个单点。
check('2c 推导值单点：sandboxTierForCwd 取自 JSON、hostPolicySnapshot 复用它、main.js 真接线', () => {
  // (1) 单点行为钉死（两处调用方共享这一条覆盖）
  if (typeof cjsShell.sandboxTierForCwd !== 'function') {
    throw new Error('main/approvalPolicy.js 未导出 sandboxTierForCwd —— 两处调用方无法共享同一判定');
  }
  eq(cjsShell.sandboxTierForCwd('/tmp/some-project'), data.snapshot.withCwd, 'sandboxTierForCwd(有 cwd)');
  eq(cjsShell.sandboxTierForCwd(''), data.snapshot.withoutCwd, 'sandboxTierForCwd(无 cwd)');
  eq(cjsShell.sandboxTierForCwd(undefined), data.snapshot.withoutCwd, 'sandboxTierForCwd(undefined) 应等同无 cwd');

  // (2) hostPolicySnapshot 必须**复用**单点而不是各算一遍（否则「单点」只是名义上的）
  for (const cwd of ['/tmp/x', '', undefined]) {
    eq(cjsShell.hostPolicySnapshot(cwd, 'on-request').sandboxPolicy, cjsShell.sandboxTierForCwd(cwd),
      `hostPolicySnapshot(cwd=${JSON.stringify(cwd)}).sandboxPolicy 应等于 sandboxTierForCwd 同一入参`);
  }

  // (3) 渲染层同样刻意没有它（与 hostPolicySnapshot 同属「快照构造」，渲染层只做钳制）
  if (esmShell.sandboxTierForCwd !== undefined) {
    throw new Error('渲染层（roleClamp.mjs）不应有 sandboxTierForCwd —— 它属于「建组快照/定时通道」侧；这是有意的非对称，不要为「对称」补副本');
  }

  // (4) main.js 的「手抄派生表达式」由断言 2d 统一窄模式扫描（不在这里重复一遍：两种模式扫同一文件
  //     会在 future 出现合法档名比较时一条红一条绿，反而说不清）。

  // (5) 接线：不仅「删了字面量」，还得真的调单点 + 从 approvalPolicy 解构出来。
  //     只验「没有字面量」是不够的 —— 有人可能删了字面量却没接线（运行时 ReferenceError，X14 同类）。
  const mainSrc = readCode('main/main.js');
  if (!/sandboxPolicy:\s*sandboxTierForCwd\(\s*rc\.dir\s*\)/.test(mainSrc)) {
    throw new Error('main/main.js 的定时通道未调用 sandboxTierForCwd(rc.dir) —— 第二份手抄可能被删了但没接线');
  }
  if (!/const\s*\{\s*hostPolicySnapshot\s*,\s*sandboxTierForCwd\s*\}\s*=\s*require\('\.\/approvalPolicy'\)/.test(mainSrc)) {
    throw new Error("main/main.js 未从 './approvalPolicy' 解构 sandboxTierForCwd（运行时会是 ReferenceError）");
  }
});

// ── 2d. 派生表达式棘轮：cwd→沙箱档的「手抄体」只许减少 ─────────────────────
// 窄模式，**只**认 `? 'workspace-write' : 'read-only'` 这个派生表达式，不扫全部档名字面量：
// sandbox.js / sandboxWindows.js / exec.js 里有几十处 `policy === 'full-access'` 这类**比较**，
// 那是合法的（比较 ≠ 推导），扫全部档名会成片假红，也会把本门禁的责任边界糊掉。
//
// ⚠️ 口径边界（别把本断言读成「全仓 0 处」）：
//   本门禁的「单源」指的是**快照/回落路径** —— hostPolicySnapshot（建组时固化、随组持久化）、
//   sandboxTierForCwd、以及 workerPool 对旧组的回落。这三处一律走单点。
//   而 main/tools/exec.js 的 2 处是「**逐次执行的默认档**」回落（调用方未显式指定策略时的兜底），
//   角色与快照不同 —— 同一件事 approvalPolicy.js 的 JSDoc「边界说明（别过度声称）」已写过。
//   所以 exec.js **不是缺口**，是 allow-list。谁按「全仓 0 处」去验收、顺手把这 2 处也改掉，
//   本条会红 —— 那个红是对的：要么改的是「逐次默认档」语义（需单独评估），要么 800 软档已经不可用。
const DERIVE_PATTERN = /\?\s*'workspace-write'\s*:\s*'read-only'/;
const DERIVE_ALLOWLIST = {
  // 单源所在：它的两个值取自 JSON 的 snapshot 段，这里必须 0 处
  'main/approvalPolicy.js': 0,
  // 定时通道（无人值守）：已走 sandboxTierForCwd
  'main/main.js': 0,
  // Worker 旧组回落：已走 sandboxTierForCwd
  'main/workerPool.js': 0,
  // exec.js 是 **allow-list（不是无视）**：实测 wc -l = 799 raw / split('\n').length = 800，
  // 800 软档余 0 行 —— 改它至少要多一行 require 就撞红，而纪律禁止往 BASELINE_800 新增条目。
  // 正确做法是「先抽模块再改」，属下一批（台账 D-13-b）。
  // 恰好 2 处是**只减不增棘轮**：降到 1 处也红，提醒把本表收紧到 1（否则它会慢慢腐烂成永久豁免）。
  'main/tools/exec.js': 2,
};
check('2d 派生表达式棘轮（窄模式）：快照路径 approvalPolicy/main/workerPool 必须 0 处手抄，exec.js 恰好 2 处（allow-list，非缺口）', () => {
  const report = [];
  for (const [rel, expected] of Object.entries(DERIVE_ALLOWLIST)) {
    // code 口径（readCode 剥注释）：注释里贴旧代码提醒不算违规
    const hits = (readCode(rel).match(new RegExp(DERIVE_PATTERN.source, 'g')) || []).length;
    report.push(`${rel}=${hits}`);
    if (hits !== expected) {
      const hint = expected === 0
        ? '必须改走 sandboxTierForCwd 单点（档名唯一出处是 shared/rolePolicyData.json）'
        : `allow-list 棘轮：只许减少不允许增加；若真减少了，同批把本表收紧到 ${hits}。若变成 0，说明有人也收敛了这处「逐次执行默认档」回落 —— 那是语义变更，需单独评估并在本表留证，不要仅为凑「全仓 0 处」去改`;
      throw new Error(`${rel} 里「cwd ? 'workspace-write' : 'read-only'」手抄体有 ${hits} 处，期望 ${expected} 处 —— ${hint}。全表实测：${report.join(' / ')}`);
    }
  }
});

// ── 3. 缺失即红：数据缺段 / 坏 JSON 一律报错，不许默认空对象兜底 ─────────────
check('3 缺失即红：JSON 缺 approval / sandbox / default，或根本不是合法 JSON → 立刻报错（禁空对象兜底）', () => {
  const without = (k) => { const c = structuredClone(data); delete c[k]; return c; };
  mustThrow(() => assertDataShape({}), '完全空的 JSON 对象');
  mustThrow(() => assertDataShape({ schemaVersion: 1 }), '只有 schemaVersion');
  mustThrow(() => assertDataShape(without('approval')), '缺 approval 段');
  mustThrow(() => assertDataShape(without('sandbox')), '缺 sandbox 段');
  mustThrow(() => assertDataShape({ ...structuredClone(data), approval: { order: data.approval.order } }), '缺 approval.default');
  mustThrow(() => assertDataShape({ ...structuredClone(data), sandbox: { order: {}, default: 'workspace-write' } }), 'sandbox.order 为空表');
  mustThrow(() => assertDataShape({ ...structuredClone(data), approval: { order: data.approval.order, default: 'paranoid' } }), 'default 不在 order 内');
  // snapshot 段：缺段 / 缺键 / 值不是合法档位，一律抛（推理同 approval/sandbox：不许兜底）
  mustThrow(() => assertDataShape(without('snapshot')), '缺 snapshot 段');
  mustThrow(() => assertDataShape({ ...structuredClone(data), snapshot: { withCwd: 'workspace-write' } }), '缺 snapshot.withoutCwd');
  mustThrow(() => assertDataShape({ ...structuredClone(data), snapshot: { withCwd: 'workspace-write', withoutCwd: 'no-such-tier' } }), 'snapshot.withoutCwd 不是合法档位');
  mustThrow(() => assertDataShape({ ...structuredClone(data), snapshot: { withCwd: 42, withoutCwd: 'read-only' } }), 'snapshot.withCwd 不是字符串');
  mustThrow(() => JSON.parse('{ "schemaVersion": 1, '), '坏成非法 JSON 的文件');
  // 真实文件必须过校验（证明上面那些负例守的是同一道闸，而不是旁路）
  assertDataShape(data);

  // 两壳的取数路径不得带兜底语法（`|| {}` / `?? {}` 会把「缺段」变成「静默空表」）
  const shells = { 'main/approvalPolicy.js': readCode('main/approvalPolicy.js'), 'shared/roleClamp.mjs': readCode('shared/roleClamp.mjs') };
  for (const [rel, src] of Object.entries(shells)) {
    if (/\|\|\s*\{\s*\}|\?\?\s*\{\s*\}/.test(src)) throw new Error(`${rel} 对数据用了空对象兜底（|| {} / ?? {}）—— 缺段会静默变成空表`);
    if (/try\s*\{[\s\S]*rolePolicyData[\s\S]*\}\s*catch/.test(src)) throw new Error(`${rel} 把数据加载包在 try/catch 里 —— 缺段会被吞掉`);
  }
  // 取数语句必须在场且指向同一份文件（防「测试绿了但壳读的是别的文件」）
  if (!/require\('\.\.\/shared\/rolePolicyData\.json'\)/.test(shells['main/approvalPolicy.js'])) {
    throw new Error('main/approvalPolicy.js 未从 ../shared/rolePolicyData.json 取数');
  }
  if (!/from '\.\/rolePolicyData\.json'/.test(shells['shared/roleClamp.mjs'])) {
    throw new Error('shared/roleClamp.mjs 未从 ./rolePolicyData.json 取数');
  }
});

// ── 4. 自检：本门禁的比较器不是恒真 ────────────────────────────────────
check('4 自检（变异测试）：改 JSON 任一档位数值/默认档/新增档位 → 断言 1 必红；恢复 → 绿', () => {
  let mutations = 0;
  for (const [side, part] of Object.entries({ approval: data.approval, sandbox: data.sandbox })) {
    for (const tier of Object.keys(part.order)) {
      const m = structuredClone(data);
      m[side].order[tier] = m[side].order[tier] + 100;
      mustThrow(() => assertSingleSource(m, cjsShell, esmShell), `把 ${side}.order.${tier} 的数值改掉`);
      mutations++;
    }
    const md = structuredClone(data);
    md[side].default = Object.keys(part.order).find((t) => t !== part.default);
    mustThrow(() => assertSingleSource(md, cjsShell, esmShell), `把 ${side}.default 改成另一档`);
    mutations++;
    // 反向：JSON 单方面新增一个档位（两侧都没跟上）也必须红 —— 否则会静默被归一化成默认档
    const ma = structuredClone(data);
    ma[side].order.paranoid = 99;
    mustThrow(() => assertSingleSource(ma, cjsShell, esmShell), `${side}.order 单方面新增档位 paranoid`);
    mutations++;
    // 反向：JSON 单方面删掉一个档位
    const mr = structuredClone(data);
    delete mr[side].order[Object.keys(part.order)[0]];
    mustThrow(() => assertSingleSource(mr, cjsShell, esmShell), `${side}.order 单方面删掉一个档位`);
    mutations++;
  }
  if (mutations < 10) throw new Error(`变异覆盖不足：只做了 ${mutations} 次`);
  // 推导值（snapshot）也必须在护：把它改成另一个**合法**档位（如 read-only → full-access），
  // order/default 全都不用动，上面的变异全都抓不到，但无目录场景的权限被静默放开。
  const ms = structuredClone(data);
  ms.snapshot.withoutCwd = 'full-access';
  mustThrow(() => assertSingleSource(ms, cjsShell, esmShell), '把 snapshot.withoutCwd 改成另一个合法档位 full-access');
  mutations++;
  const ms2 = structuredClone(data);
  ms2.snapshot.withCwd = 'workspace-write-bogus';
  mustThrow(() => assertSingleSource(ms2, cjsShell, esmShell), '把 snapshot.withCwd 改成非法档位名');
  mutations++;
  if (mutations < 12) throw new Error(`变异覆盖不足：只做了 ${mutations} 次`);
  // 恢复原件必须重新变绿（证明上面的红来自变异，不是比较器本身就坏）
  assertSingleSource(data, cjsShell, esmShell);
});

// ── 5. 契约不外泄：CONTRACT 只允许活在门禁里 ─────────────────────────────
// 断言 1 刻意让门禁冗余一份「经评审的期望值」（契约冻结）。这份冗余一旦被**生产代码**引用，就立刻
// 变成第四份事实源 —— 而且是最坏的一种：它自带「经评审」光环，却没有任何门禁再去核对它与 JSON 是否
// 同步（本文件只核对「门禁 ↔ JSON」）。所以生产侧一律不得出现该标识符；要改严格序，改 JSON +
// 同批改本文件的 CONTRACT（= 进 review diff），不许绕道生产代码读契约。
const PROD_SOURCE_DIRS = ['main', 'shared', 'agent-core', 'renderer/src'];
// 比约定多扫 .cjs：少扫一种扩展名就是一个可以夹带契约的缺口（更严 = 安全）
const PROD_SOURCE_EXT = /\.(js|mjs|cjs|ts|tsx)$/;
function walkProdSources(dirRel) {
  const rootDir = path.join(DESKTOP, dirRel);
  // 目录不存在 → 直接抛：改名/移动后若静默返回空列表，本门禁会「扫了 0 个文件」而永远绿
  if (!fs.existsSync(rootDir)) throw new Error(`扫描目录不存在：${dirRel}（本门禁会静默空扫，故 fail-closed）`);
  const files = [];
  const stack = [rootDir];
  while (stack.length) {
    const cur = stack.pop();
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === 'dist') continue;
      const abs = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(abs);
      else if (ent.isFile() && PROD_SOURCE_EXT.test(ent.name)) files.push(abs);
    }
  }
  return files;
}

check('5 契约不外泄：main/shared/agent-core/renderer/src 下不得出现标识符 CONTRACT（注释里提不算）', () => {
  const files = PROD_SOURCE_DIRS.flatMap(walkProdSources);
  // 扫描面自检：真扫到东西才算门禁。当前实测 222 个源文件，留足余量只挡「明显空扫」。
  if (files.length < 150) {
    throw new Error(`扫描面过小（只有 ${files.length} 个源文件）—— 目录结构变了，先同步本门禁，别让它空扫成绿`);
  }
  const hits = [];
  for (const abs of files) {
    // 剥注释后再匹配（与断言 1 同一纪律）：注释里写「CONTRACT 只允许在门禁」这样的提醒不算违规。
    // 已知限制：stripComments 是手写状态机，含 `/*` 的正则字面量可能被误判（台账：下批抽公共 helper）。
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    if (/\bCONTRACT\b/.test(code)) hits.push(path.relative(DESKTOP, abs));
  }
  if (hits.length) {
    throw new Error(`契约期望值只允许存在于门禁，生产代码引用它 = 出现第四份事实源 —— 命中 ${hits.length} 处：${hits.join(', ')}`);
  }
});

if (process.exitCode === 1) console.error(`\nFAIL：${total - pass}/${total} 项失败`);
else console.log(`\nPASS：${pass}/${total} 项通过`);

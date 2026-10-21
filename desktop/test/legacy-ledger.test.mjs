// 存量收敛台账一致性门禁（F-017 / B2-B-13）
//
// 治理的问题：两个存量指标原来都只是「ratchet 上限」，只防恶化、不防挂账。
//   · 死 bridge 方法：bridge-parity 只断言「占比 ≤ 40%」，而实际 22.8% —— 上限形同虚设。
//   · 裸 button：ui-conventions 用 `count <= 258` —— 一个都不清也算通过。
// 本套件把「数字」升级成「台账」：docs/harness-r7/legacy-ledger.json 必须与**现算**完全一致。
//
// 核心语义（写在错误信息里，避免下一个人把红灯当成 bug 去绕）：
//   **存量变化不是错，但必须同步台账并说明处置。**
// 也就是说：你清理了 5 个死方法 → 本套件报红 → 这是**预期**行为，请重新 `--write`
// 更新台账并在 docs/harness-r7/存量收敛台账.md 里说明这批的处置（consume/exempt/…）。
// 反过来，你新增了裸 button → 也报红 → 同样必须先降到基线以下再更新台账。
// 两个方向都红，是为了让台账**永远等于现实**，而不是变成一份没人对得上的旧快照。
//
// 另有三条防「恒绿」的自检：
//   ① 剥 disposition 的比对函数必须真能剥（否则比对退化成「比 disposition 之外什么都比」）；
//   ② 台账 rawButton 总数必须等于 ui-conventions.test.js 里**写死的基线数字**
//      （防生成器口径漂移：若生成器漏扫某个目录，它自己和自己一致但和门禁对不上）；
//   ③ 分组计数之和必须等于总数（防分组时漏掉成员却仍报「一致」）。
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(ROOT, '..');
const LEDGER_PATH = path.join(REPO, 'docs/harness-r7/legacy-ledger.json');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const HINT = '（存量变化不是错，但必须同步台账并说明处置：'
  + '重新跑 `node scripts/gen-legacy-ledger.mjs --write`，并在 docs/harness-r7/存量收敛台账.md 说明本批处置）';

// 深比较 + 可读差异（不引第三方依赖；只比对本套件关心的 JSON 子集）
function deepDiff(actual, expected, at = '$', out = []) {
  const isObj = (v) => v !== null && typeof v === 'object';
  if (!isObj(actual) || !isObj(expected)) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      out.push(`${at}: 台账=${JSON.stringify(actual)} 现算=${JSON.stringify(expected)}`);
    }
    return out;
  }
  if (Array.isArray(actual) !== Array.isArray(expected)) {
    out.push(`${at}: 类型不一致（数组=${Array.isArray(actual)} vs ${Array.isArray(expected)}）`);
    return out;
  }
  if (Array.isArray(actual)) {
    if (actual.length !== expected.length) {
      out.push(`${at}: 条目数 台账=${actual.length} 现算=${expected.length}`);
    }
    const n = Math.max(actual.length, expected.length);
    for (let i = 0; i < n; i++) {
      if (i >= actual.length) { out.push(`${at}[${i}]: 台账缺失（现算有 ${JSON.stringify(expected[i])}）`); continue; }
      if (i >= expected.length) { out.push(`${at}[${i}]: 台账多出（现算无 ${JSON.stringify(actual[i])}）`); continue; }
      deepDiff(actual[i], expected[i], `${at}[${i}]`, out);
    }
    return out;
  }
  for (const k of Object.keys(expected)) {
    if (!(k in actual)) out.push(`${at}.${k}: 台账缺失（现算=${JSON.stringify(expected[k])}）`);
    else deepDiff(actual[k], expected[k], `${at}.${k}`, out);
  }
  for (const k of Object.keys(actual)) {
    if (!(k in expected)) out.push(`${at}.${k}: 台账多出（现算无此字段）`);
  }
  return out;
}

// ── 0. 台账存在且结构可解析 ──
let ledger = null;
try { ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')); } catch (e) {
  check('台账 JSON 存在且可解析', false, `${LEDGER_PATH}：${e.message}`);
}
if (!ledger) {
  console.log(`\nlegacy-ledger: ${pass}/${pass + fail} 通过（台账缺失，后续断言跳过）`);
  process.exit(1);
}
check('台账 JSON 存在且可解析', true, path.relative(REPO, LEDGER_PATH));

const gen = await import(path.join(ROOT, 'scripts/gen-legacy-ledger.mjs'));
const live = gen.computeLedger();

check('台账 schemaVersion 与生成器一致',
  ledger.schemaVersion === live.schemaVersion, `台账=${ledger.schemaVersion} 生成器=${live.schemaVersion}`);
check('台账记录了生成器路径（可追溯到唯一事实来源）',
  ledger.generator === live.generator, String(ledger.generator));

// ── 1. 核心断言：台账 === 现算（剥掉人工 disposition 后逐字节一致）──
// 「任一项变化（增或减）都红」由这里保证：比对覆盖 totals、ratio、referenced、
// scannedFiles、以及**每个分组的 key 与 count**（含分组增删）。
{
  const a = gen.stripDisposition(ledger);
  const b = gen.stripDisposition(live);
  const diffs = deepDiff(a, b);
  check(`台账与现算完全一致（死 bridge ${live.metrics.deadBridgeMethods.dead}/`
    + `${live.metrics.deadBridgeMethods.total}，裸 button ${live.metrics.rawButtons.total}，`
    + `${live.metrics.deadBridgeMethods.groups.length}+${live.metrics.rawButtons.groups.length} 个分组）`,
  diffs.length === 0,
  diffs.length === 0 ? '逐字段一致' : `${diffs.length} 处不一致 ${HINT}\n    ` + diffs.slice(0, 25).join('\n    '));
}

// ── 2. 分组计数之和 === 总数（防分组漏成员）──
{
  const b = live.metrics.deadBridgeMethods;
  const sum = b.groups.reduce((s, g) => s + g.count, 0);
  check('死 bridge：分组计数之和 === dead 总数（分组无遗漏成员）',
    sum === b.dead, `分组和=${sum} dead=${b.dead}`);
  const r = live.metrics.rawButtons;
  const rsum = r.groups.reduce((s, g) => s + g.count, 0);
  check('裸 button：分组计数之和 === total（分组无遗漏文件）',
    rsum === r.total, `分组和=${rsum} total=${r.total}`);
  check('死 bridge：referenced + dead === total（三数自洽，无重复计数）',
    b.referenced + b.dead === b.total, `${b.referenced}+${b.dead} vs ${b.total}`);
}

// ── 3. disposition 字段合法（人工状态不许写错词，否则排期语义失效）──
{
  const bad = [];
  for (const [metric, key] of [['deadBridgeMethods', 'prefix'], ['rawButtons', 'file']]) {
    for (const g of live.metrics[metric].groups) {
      const d = (ledger.metrics[metric].groups.find((x) => x[key] === g[key]) || {}).disposition;
      if (!gen.DISPOSITIONS.includes(d)) bad.push(`${metric}/${g[key]}=${JSON.stringify(d)}`);
    }
  }
  check('disposition 取值均在 pending/consume/retire/exempt 内',
    bad.length === 0, bad.length ? bad.join(', ') : `全部合法（${gen.DISPOSITIONS.join('/')}）`);
  const missing = [];
  for (const metric of ['deadBridgeMethods', 'rawButtons']) {
    for (const g of live.metrics[metric].groups) {
      const hit = ledger.metrics[metric].groups.find((x) => (x.prefix || x.file) === (g.prefix || g.file));
      if (!hit || !('disposition' in hit)) missing.push(`${metric}/${g.prefix || g.file}`);
    }
  }
  check('每个分组都带 disposition 字段（缺字段＝该组无处置归属）',
    missing.length === 0, missing.length ? `缺：${missing.join(', ')}` : '全部分组已带');
}

// ── 4. 与两个既有门禁的口径交叉校验（防「生成器自己和自己一致」）──
{
  // 4a. 裸 button：ui-conventions.test.js 里写死的基线就是权威数字
  const uiSrc = fs.readFileSync(path.join(ROOT, 'test/ui-conventions.test.js'), 'utf8');
  const m = uiSrc.match(/rawButton:\s*(\d+)/);
  const gateBaseline = m ? Number(m[1]) : null;
  check('裸 button：台账总数 === ui-conventions.test.js 的 rawButton 基线（口径未漂移）',
    gateBaseline !== null && live.metrics.rawButtons.total === gateBaseline,
    `台账=${live.metrics.rawButtons.total} 门禁基线=${gateBaseline}`);

  // 4b. 死 bridge：C-05 收口后 bridge-parity 已改为**显式台账**（不再只看占比上限），
  // 因此这里断言「门禁确实引用同一份台账」——否则两套口径会各自漂移。
  const bpSrc = fs.readFileSync(path.join(ROOT, 'test/bridge-parity.test.mjs'), 'utf8');
  const b = live.metrics.deadBridgeMethods;
  const ledgerGate = /bridge-dead-allowlist\.json/.test(bpSrc);
  check('死 bridge：bridge-parity 已按显式台账门禁（绝对数 + 双向差集）',
    ledgerGate,
    `占比=${(b.dead / b.total * 100).toFixed(1)}% 台账门禁=${ledgerGate ? '已启用' : '未接线'}`);
  // 门禁只守上限 → 明确记录「台账比门禁更严」这一事实，防止有人以为台账多余
  check('死 bridge：台账记录了绝对数（门禁只有占比，绝对数变化门禁看不见 → 台账补的正是这一块）',
    typeof b.dead === 'number' && typeof b.total === 'number' && b.total > 0,
    `dead=${b.dead} total=${b.total}`);
}

// ── 5. 自检：比对函数不是恒真 ──
{
  // 5a. stripDisposition 必须真剥掉 disposition。若它退化成 `return ledger`，
  //     人工改 disposition 会让「台账===现算」永远红（噪声）或永远绿（假闸），两者都不可接受。
  const withDisp = JSON.parse(JSON.stringify(live));
  withDisp.metrics.deadBridgeMethods.groups[0].disposition = 'exempt';
  check('自检：stripDisposition 真能剥掉 disposition（人工状态不参与一致性判定）',
    !JSON.stringify(gen.stripDisposition(withDisp)).includes('"disposition"'));

  // 5b. 改动任意一个 count（增或减）→ deepDiff 必须报出。
  const bumped = JSON.parse(JSON.stringify(live));
  bumped.metrics.deadBridgeMethods.dead += 1;
  const d1 = deepDiff(bumped, live);
  check('自检：dead 总数 +1 → 比对报红（增也红）', d1.length > 0, d1[0] || '（未报错＝假闸）');
  const trimmed = JSON.parse(JSON.stringify(live));
  trimmed.metrics.rawButtons.groups[0].count -= 1;
  const d2 = deepDiff(trimmed, live);
  check('自检：分组 count −1 → 比对报红（减也红）', d2.length > 0, d2[0] || '（未报错＝假闸）');
  const dropped = JSON.parse(JSON.stringify(live));
  dropped.metrics.rawButtons.groups.pop();
  const d3 = deepDiff(dropped, live);
  check('自检：删掉一个分组 → 比对报红（分组增删也红）', d3.length > 0, d3[0] || '（未报错＝假闸）');
}

// ── 6. 人读文档存在（台账不是一堆没人解释的 JSON）──
{
  const docPath = path.join(REPO, 'docs/harness-r7/存量收敛台账.md');
  let doc = '';
  try { doc = fs.readFileSync(docPath, 'utf8'); } catch { /* 下面断言会红 */ }
  check('存在人工可读说明 docs/harness-r7/存量收敛台账.md', doc.length > 200, `${doc.length} 字符`);
  check('说明文档解释了三类处置（consume/retire/exempt 的语义）',
    ['consume', 'retire', 'exempt'].every((d) => doc.includes(d)),
    ['consume', 'retire', 'exempt'].filter((d) => !doc.includes(d)).join(',') || '三类齐全');
  // 文档里的数字必须与台账一致，否则文档会变成第二份谎话
  const b = live.metrics.deadBridgeMethods;
  check('说明文档引用的死 bridge 数字与现算一致（文档不撒谎）',
    doc.includes(String(b.dead)) && doc.includes(String(b.total)),
    `文档需含 ${b.dead} 与 ${b.total}`);
  check('说明文档引用的裸 button 数字与现算一致（文档不撒谎）',
    doc.includes(String(live.metrics.rawButtons.total)), `文档需含 ${live.metrics.rawButtons.total}`);
}

console.log(`\nlegacy-ledger: ${pass}/${pass + fail} 通过`
  + `（台账：死 bridge ${live.metrics.deadBridgeMethods.dead}/${live.metrics.deadBridgeMethods.total}，`
  + `裸 button ${live.metrics.rawButtons.total}）`);
process.exit(fail === 0 ? 0 : 1);

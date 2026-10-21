#!/usr/bin/env node
// 生态计数一致性门禁（ecosystem-counts）
//
// ── 刻意反常（下一任维护者必读，否则会顺手改坏）──
// **本套件刻意不被《MJcoder-技术流程功能文档.md》引用。** 不是漏写。
//   文档侧有一个 `desktop/test/docs-consistency.test.mjs` 的棘轮断言 `REFERENCE_COUNT_BASELINE = 28`，
//   它统计文档里出现的 `*.test.{js,mjs}` 文件名**去重个数**并要求**严格相等**（不是 `>=`，见该文件「决策 2」）。
//   一旦有人在本文件之外往技术文档里补一行「生态计数由 ecosystem-counts.test.mjs 守护」，
//   引用数就从 28 变 29，门禁立刻红 —— 而红点指向的是「文档」，不是「这里」，极易被误判为文档写错。
//   所以：**新增测试若确需在文档中登记，必须同批把 `REFERENCE_COUNT_BASELINE` 从 28 改到新值**，
//   并在 PR/回传里说明「引用数由 28→29，原因：新增 X 套件需在文档登记」。
//   反之，若只是想让人知道有这个门禁，改 README（不受该棘轮约束）即可 —— 本书面即为此而写。
//
// 要防的缺陷形态（F-010，R7 实测已发生）：
//   README 写「100 skills / 80 MCP connectors / 50 digital-employee = 230 assets」，
//   源码事实是 100 / 77 / 51 = 228（偏差 -3 / +1 / -2，合计 -2）。
//   手写数字没有守护者 → 必然随源码演进静默失真，而读者会拿它判断「精选了多少连接器 / 有多少数字员工」。
//   更隐蔽的一半：中英双语的 README 各写一份，英文改了中文没改 → 中文版（国内用户第一入口）继续误导。
//
// 设计取向：**数字不在本文件里硬编码**。本套件现算源码，再把现算结果与 README 文本比对。
//   如果反过来把 100/77/51 写成字面量断言源码，那么源码新增一个技能时本门禁自己就会红，
//   维护者会倾向于「改断言」而不是「改 README」——那就退化成弱化测试。
//   现算 → 比对 README，则源码演进时红点指向的是**README 该更新了**，处置动作唯一且正确。
//
// 口径陷阱（踩过，写在这里防止后人重犯）：
//   `ecosystem/mcp-connectors.json` 与 `ecosystem/mcp-connectors-workbuddy.json` 的**顶层都是对象**
//   （`{ version, ..., connectors: [...] }`），不是数组。`JSON.parse(text).length` 得 `undefined`，
//   而 `undefined === 77` 为 false、`100 + undefined + 51` 为 NaN —— 数字会静默变成 NaN 而不是报错。
//   故本套件对每个来源都先用 Array.isArray 断言结构，再取长度。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // desktop/
const ROOT = path.join(DESKTOP, '..');
const ECOSYSTEM = path.join(ROOT, 'ecosystem');
const README_PATH = path.join(ROOT, 'README.md');

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// ── 现算三个口径 ──

// 口径 1：skills = ecosystem/skills/ 一级子目录数
// 不用 skills.json（219 条）：那是「技能定义 + 索引/分类等非目录条目」的合集，
// 与磁盘上真实可安装的技能包目录不是同一口径；README 承诺的是 ecosystem/ 里的 asset。
const SKILLS_DIR = path.join(ECOSYSTEM, 'skills');
const skills = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.')).length;

// 口径 2 / 3：JSON 内的数组。先断结构，再取长度（见文件头「口径陷阱」）。
function arrayAt(doc, key, file) {
  const arr = key ? doc[key] : doc;
  assert.ok(Array.isArray(arr),
    `${file} 的 ${key || '(顶层)'} 必须是数组，实际是 ${arr === undefined ? 'undefined' : typeof arr}；`
    + '若结构变更请同步 gen-ecosystem-counts.mjs 与 README 口径说明');
  return arr;
}
const mcpDoc = JSON.parse(fs.readFileSync(path.join(ECOSYSTEM, 'mcp-connectors.json'), 'utf8'));
const mcp = arrayAt(mcpDoc, 'connectors', 'mcp-connectors.json').length;

const roleDoc = JSON.parse(fs.readFileSync(path.join(ECOSYSTEM, 'digital-employees.json'), 'utf8'));
const digitalEmployees = arrayAt(roleDoc, '', 'digital-employees.json').length;

const wbDoc = JSON.parse(fs.readFileSync(path.join(ECOSYSTEM, 'mcp-connectors-workbuddy.json'), 'utf8'));
const workbuddyRaw = arrayAt(wbDoc, 'connectors', 'mcp-connectors-workbuddy.json').length;

const assetTotal = skills + mcp + digitalEmployees;

const readme = fs.readFileSync(README_PATH, 'utf8');
const README_ZH_PATH = path.join(ROOT, 'README.zh-CN.md');
const readmeZh = fs.readFileSync(README_ZH_PATH, 'utf8');

// ── ① 三个口径已取到有效数值（防空 NaN / undefined 静默通过）──
check(`三个生态口径均取到有效正整数（skills=${skills} / mcp=${mcp} / digital-employees=${digitalEmployees}）`, () => {
  for (const [name, v] of [['skills', skills], ['mcp', mcp], ['digitalEmployees', digitalEmployees]]) {
    assert.equal(typeof v, 'number', `${name} 不是 number（得到 ${typeof v}）`);
    assert.ok(Number.isInteger(v) && v > 0, `${name} 必须是正整数，得到 ${v}`);
  }
  assert.equal(assetTotal, skills + mcp + digitalEmployees, '合计不等于三项之和');
});

// ── ②③ 双语 README 统一审计 ──
// 为什么必须**中英各审一遍**：F-010 的实际形态就是「英文版改了、中文版没改」。
// 只审英文版等于给中文版留了一条无限期漂移通道——而中文版正是国内用户的第一入口，
// 它写「80 个 MCP 连接器 / 230 项生态资产」造成的误导与英文版完全等价。
// 用全局扫描而非「抓某一句」：README 是累积式文档，同一组数字可能在多处出现，
// 只校验一处会留下「改了一处、另一处继续漂」的口子。
function auditDocReadme(label, text, patterns, expected) {
  for (const [what, re] of Object.entries(patterns)) {
    check(`${label} 中每一处「${what}」均等于现算 ${expected}`, () => {
      const nums = [...text.matchAll(re)].map((m) => Number(m[1]));
      assert.ok(nums.length > 0, `${label} 里找不到「${what}」表述（生态规模段被删改了？）`);
      const bad = nums.filter((n) => n !== expected);
      assert.deepEqual(bad, [], `${label} 出现与源码不符的数字：${bad.join(', ')}（源码现算 ${expected}）`);
    });
  }
}

auditDocReadme('README.md', readme, { 'N skills': /(\d+)\s+skills\b/gi }, skills);
auditDocReadme('README.md', readme, { 'N MCP connectors': /(\d+)\s+MCP\s+connectors/gi }, mcp);
auditDocReadme('README.md', readme, { 'N digital-employee': /(\d+)\s+digital-employee/gi }, digitalEmployees);
auditDocReadme('README.md', readme, { 'N ecosystem assets': /(\d+)\s+ecosystem assets/gi }, assetTotal);

// 中文版：字面形态不同（「100 个技能」「77 个 MCP 连接器」「51 个数字员工」「228 项生态资产」），
// 故单独给一组正则——不能拿英文正则去套中文，否则 nums.length 为 0 会被误判成「表述被删」。
auditDocReadme('README.zh-CN.md', readmeZh, { 'N 个技能': /(\d+)\s*个技能/g }, skills);
auditDocReadme('README.zh-CN.md', readmeZh, { 'N 个 MCP 连接器': /(\d+)\s*个\s*MCP\s*连接器/gi }, mcp);
auditDocReadme('README.zh-CN.md', readmeZh, { 'N 个数字员工': /(\d+)\s*个数字员工/g }, digitalEmployees);
auditDocReadme('README.zh-CN.md', readmeZh, { 'N 项生态资产': /(\d+)\s*项生态资产/g }, assetTotal);

// ── ③ 内联合计：两种语言的「(… = N)」写法都必须等于现算总数 ──
check(`README.md 内联合计等于现算 ${assetTotal}`, () => {
  let seen = 0;
  for (const m of readme.matchAll(/role templates\s*=\s*\*{0,2}(\d+)/gi)) {
    seen++;
    assert.equal(Number(m[1]), assetTotal, `内联合计「role templates = ${m[1]}」应为 ${assetTotal}`);
  }
  assert.ok(seen > 0, 'README.md 找不到内联合计「role templates = N」');
});
check(`README.zh-CN.md 内联合计等于现算 ${assetTotal}`, () => {
  let seen = 0;
  // 中文版写成「51 个数字员工角色模板 = 228」
  for (const m of readmeZh.matchAll(/个数字员工\*{0,2}角色模板\*{0,2}\s*=\s*(\d+)/g)) {
    seen++;
    assert.equal(Number(m[1]), assetTotal, `内联合计「角色模板 = ${m[1]}」应为 ${assetTotal}`);
  }
  // 括号内的三元组「（100 技能 / 77 MCP 连接器 / 51 数字员工角色模板）」
  let triple = 0;
  for (const m of readmeZh.matchAll(/（\s*(\d+)\s*技能\s*\/\s*(\d+)\s*MCP\s*连接器\s*\/\s*(\d+)\s*数字员工角色模板\s*）/g)) {
    triple++;
    assert.deepEqual(
      [Number(m[1]), Number(m[2]), Number(m[3])],
      [skills, mcp, digitalEmployees],
      `中文版括号三元组与源码不符：${m[1]}/${m[2]}/${m[3]}`,
    );
  }
  assert.ok(triple > 0, 'README.zh-CN.md 找不到「（N 技能 / N MCP 连接器 / N 数字员工角色模板）」三元组');
  assert.ok(seen > 0, 'README.zh-CN.md 找不到内联合计「数字员工角色模板 = N」');
});

// ── ④ WorkBuddy 原始清单：必须与精选清单零重叠，且必须声明「不计入合计」──
// 若将来有人把两份清单合并去重，或把 214 加进总数，这条会红。
check(`WorkBuddy 原始清单（${workbuddyRaw} 条）与精选清单（${mcp} 条）id 零重叠`, () => {
  const keyOf = (c) => c.id || c.name || c.slug || JSON.stringify(c).slice(0, 64);
  const curated = new Set(arrayAt(mcpDoc, 'connectors', 'mcp-connectors.json').map(keyOf));
  const raw = arrayAt(wbDoc, 'connectors', 'mcp-connectors-workbuddy.json').map(keyOf);
  const overlap = raw.filter((k) => curated.has(k));
  assert.deepEqual(overlap.slice(0, 5), [],
    `${overlap.length} 条 id 重叠（示例：${overlap.slice(0, 5).join(', ')}）；两套清单若已重叠，README 的「零重叠 / 独立命名空间」表述与「不计入 228」口径都需重新推导`);
});
check('README.md 明确声明 WorkBuddy 原始清单不计入合计', () => {
  assert.ok(new RegExp(`${workbuddyRaw}\\s*-?\\s*entry`, 'i').test(readme),
    `README 未写出原始清单条数 ${workbuddyRaw}`);
  assert.ok(/not\s+\*{0,2}counted|excluded/i.test(readme),
    'README 未声明该清单不计入合计（读者会自己加总）');
  assert.ok(/zero\s+(id\s+)?overlap/i.test(readme), 'README 未声明两套清单零重叠');
});
check('README.zh-CN.md 明确声明 WorkBuddy 原始清单不计入合计', () => {
  assert.ok(new RegExp(`${workbuddyRaw}\\s*条`).test(readmeZh),
    `中文版 README 未写出原始清单条数 ${workbuddyRaw}`);
  assert.ok(/不计入/.test(readmeZh), '中文版未声明该清单不计入合计（读者会自己加总）');
  assert.ok(/零重叠/.test(readmeZh), '中文版未声明两套清单零重叠');
});

// ── ⑤ 生成脚本与门禁同口径（防止脚本和测试各自演化出两套算法）──
check('gen-ecosystem-counts.mjs 现算结果与本门禁一致', () => {
  // 脚本是 ESM，无法 require；用子进程同步取 --json 输出，保证「脚本算法」与「门禁算法」只有一套语义。
  const out = execFileSync(process.execPath,
    [path.join(DESKTOP, 'scripts', 'gen-ecosystem-counts.mjs'), '--json'],
    { encoding: 'utf8', cwd: DESKTOP, timeout: 60_000 });
  const got = JSON.parse(out);
  assert.equal(got.skills, skills, '脚本 skills 与本门禁不一致');
  assert.equal(got.mcp, mcp, '脚本 mcp 与本门禁不一致');
  assert.equal(got.digitalEmployees, digitalEmployees, '脚本 digitalEmployees 与本门禁不一致');
  assert.equal(got.total, assetTotal, '脚本 total 与本门禁不一致');
  assert.equal(got.workbuddyRaw, workbuddyRaw, '脚本 workbuddyRaw 与本门禁不一致');
});

// ── ⑥ 防回归：已被证伪的旧数字不得回流（中英双语各扫一遍）──
// 这三组是 F-010 实测偏差值（80 / 50 / 230）。它们不是「猜的可能值」，
// 而是**已经写错过一次**的字面量，所以值得用字面量钉死。
// 必须双语都扫：本轮修复前的真实形态就是「英文版改对了、中文版 80/50/230 原封不动」——
// 只扫英文版等于给中文版留一条无限期漂移通道。
check('已证伪的旧数字不得回流（README.md）', () => {
  const banned = [/\b80\s+MCP\s+connectors/i, /\b50\s+digital-employee/i, /\b230\s+ecosystem\s+assets/i];
  const hits = banned.filter((re) => re.test(readme)).map((re) => re.source);
  assert.deepEqual(hits, [], `README.md 出现已证伪的旧数字：${hits.join(' | ')}`);
});
check('已证伪的旧数字不得回流（README.zh-CN.md）', () => {
  const banned = [/\b80\s*个\s*MCP\s*连接器/, /\b50\s*个数字员工/, /\b230\s*项/, /100\s*\/\s*80\s*\/\s*50/];
  const hits = banned.filter((re) => re.test(readmeZh)).map((re) => re.source);
  assert.deepEqual(hits, [], `README.zh-CN.md 出现已证伪的旧数字：${hits.join(' | ')}`);
});

// ── ⑦ D-812（2026-10-21）：口径分离 + 技术设计文档「生态资产」行对账 ──
// L-2 记录的「四组数字对不上」经实测是**假冲突**：219 / 100 / 154 量的是三件不同的事
// （目录条目 / 随包发布实体 / 本机已安装）。真正的缺陷是「数字没有口径」，
// 于是任何两次引用都可能被读成矛盾。这一节把它变成结构约束：口径分开算、分开命名、
// 文档那一行必须与现算一致，且**对账逻辑本身要被变异验证**（否则它可能只是个恒真的空壳）。
{
  const counts = JSON.parse(execFileSync(process.execPath,
    [path.join(DESKTOP, 'scripts', 'gen-ecosystem-counts.mjs'), '--json'],
    { encoding: 'utf8', cwd: DESKTOP, timeout: 60_000 }));

  check(`口径分离：skillsCatalog(${counts.skillsCatalog}) 与 skills(${skills}) 是两个不同数字`, () => {
    assert.ok(Number.isInteger(counts.skillsCatalog) && counts.skillsCatalog > 0,
      `skillsCatalog 必须是正整数，得到 ${counts.skillsCatalog}`);
    assert.notEqual(counts.skillsCatalog, skills,
      '两个口径相等 ⇒ 疑似把「目录条目」与「磁盘实体」合成一个来源了；'
      + '它们本来就不该相等（条目含索引/分类等非目录项），请检查 gen-ecosystem-counts.mjs');
  });

  check('工作区口径单独存在时为 null 或正整数（不拿 0 冒充「没有技能」）', () => {
    assert.ok(counts.workspaceSkills === null || (Number.isInteger(counts.workspaceSkills) && counts.workspaceSkills > 0),
      `workspaceSkills 只能是 null 或正整数，得到 ${counts.workspaceSkills}`);
  });

  // 工作区口径绝不可被写进 README 的「技能数」——那会把「本机装了 154」当成「产品有 154 个技能」。
  check('README 未把工作区安装数当技能数（口径混用回流防线）', () => {
    const ws = counts.workspaceSkills;
    if (!Number.isInteger(ws)) return; // 本机不存在该目录时无从回流
    assert.ok(!new RegExp(`\\b${ws}\\s+skills\\b`, 'i').test(readme),
      `README.md 出现「${ws} skills」——那是本机已安装数，不是随包发布的技能数（应为 ${skills}）`);
    assert.ok(!new RegExp(`\\b${ws}\\s*个技能`).test(readmeZh),
      `README.zh-CN.md 出现「${ws} 个技能」——同上`);
  });

  // 技术设计文档的「生态资产」行参与对账：它是给内部看的总账，最容易被写成「哪个数看起来对就用哪个」。
  const DESIGN_DOC = path.join(ROOT, 'docs', 'MJCode-技术设计文档-2026-10-17.md');
  const docText = fs.readFileSync(DESIGN_DOC, 'utf8');
  function auditEcosystemRow(text) {
    // 必须锚定「首列是生态资产」的表格行：全文提到「生态资产」的行不止一处（R28 已知问题行也提到），
    // 用 includes 会抓错行 —— 这是本门禁第一版真实犯过的错，故此处保留锚定写法。
    const row = text.split('\n').find((l) => /^\|\s*生态资产\s*\|/.test(l));
    assert.ok(row, '技术设计文档缺少「| 生态资产 |」行（章节被改名或整行删除）');
    const nums = new Set(row.match(/\d+/g) || []);
    const expect = [
      ['数字员工', counts.digitalEmployees],
      ['技能目录条目', counts.skillsCatalog],
      ['内置技能实体', skills],
      ['连接器双清单合计', counts.mcp + counts.workbuddyRaw],
      ['精选清单', counts.mcp],
      ['WorkBuddy 导入', counts.workbuddyRaw],
    ];
    const missing = expect.filter(([, v]) => !nums.has(String(v))).map(([k, v]) => `${k}=${v}`);
    assert.deepEqual(missing, [],
      `文档该行缺少现算值：${missing.join('、')}；当前行：${row.trim().slice(0, 160)}`);
  }
  check(`技术设计文档「生态资产」行含全部现算值（6 个口径）`, () => auditEcosystemRow(docText));

  // 变异自证：同一个审计函数喂一份错数字的文本，必须抛错。
  // 不做这步，「对账一致」可能只是因为函数什么都没查（空过比红更危险）。
  check('变异自证：错数字的「生态资产」行必须被拒（对账不是空转）', () => {
    assert.throws(() => auditEcosystemRow('| 生态资产 | 数字员工 999、技能目录条目 1 |'), /缺少现算值/);
    assert.throws(() => auditEcosystemRow('| 别的行 | 1 |'), /缺少「\| 生态资产 \|」行/);
  });
}

console.log(`\necosystem-counts: ${pass}/${total} 通过`);
if (process.exitCode) console.error('（存在失败项：README 与 ecosystem/ 源码已漂移，请按提示更新 README 或核对口径）');

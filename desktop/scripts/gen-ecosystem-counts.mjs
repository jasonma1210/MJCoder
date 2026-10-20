#!/usr/bin/env node
// 生态资产计数生成器（gen-ecosystem-counts）
//
// 为什么存在：README 里的生态规模数字曾是**手写的静态值**，于是漂移成了
//   「100 skills / 80 MCP connectors / 50 digital-employee = 230 assets」，
//   而源码事实是 100 / 77 / 51 = 228（偏差 -3 / +1 / -2）。手写数字没有守护者，
//   就必然随源码演进静默失真——读者按 README 判断「精选了多少连接器」会被直接误导。
//   本脚本把口径变成**可执行的定义**：数字从源码现算，`test/ecosystem-counts.test.mjs`
//   再拿它的输出反向校验 README，形成闭环。
//
// ── 计数口径（三处都要注意，写错会静默得到 undefined 或错误基数）──
//
// 1. skills = `ecosystem/skills/` 下的**一级子目录**数（不是 `skills.json` 的条目数）。
//    为什么不用 skills.json：该文件 219 条，是「技能定义 + 索引/分类等非目录条目」的合集，
//    与磁盘上真实可安装的技能包目录（100 个）不是同一口径。README 承诺的是「assets 在 ecosystem/ 里」，
//    所以以磁盘目录为准。
//
// 2. mcp connectors = `ecosystem/mcp-connectors.json` 的 `.connectors` 数组长度。
//    ⚠️ 该文件**顶层是对象**（`{ version, ..., connectors: [...] }`），不是数组。
//    直接写 `JSON.parse(text).length` 会得 `undefined`，而 `undefined === 77` 为 false、
//    `undefined + 51` 为 NaN——总量会静默变成 NaN 而不报错。故本脚本显式校验 `Array.isArray` 并抛错。
//
// 3. digital employees = `ecosystem/digital-employees.json` 的顶层数组长度（51）。
//
// ── 不计入总数的文件 ──
// `ecosystem/mcp-connectors-workbuddy.json` → `.connectors`（214 条）：WorkBuddy 原始导入清单，
//   与精选 77 条 **id 零重叠**（实测交集为空）。两者是**两套独立命名空间**，不是父子集关系，
//   运行时不合并、不去重，故不计入 README 的 228。若把它加进来会得到 442，
//   对外宣称「生态有 442 个 MCP 连接器」即与产品实际可用能力不符。
//
// ── 用法 ──
//   node desktop/scripts/gen-ecosystem-counts.mjs           # 人类可读 + JSON
//   node desktop/scripts/gen-ecosystem-counts.mjs --json     # 仅 JSON（供测试/CI 消费）
//
// ── 刻意反常（下一任维护者必读）──
// 本脚本与配套的 `desktop/test/ecosystem-counts.test.mjs` **刻意不被《MJcoder-技术流程功能文档.md》引用**，
// 不是漏写。文档侧有 `desktop/test/docs-consistency.test.mjs` 的棘轮断言 `REFERENCE_COUNT_BASELINE = 28`，
// 统计文档中出现的 `*.test.{js,mjs}` 文件名去重个数并要求**严格相等**。若往技术文档里补一行引用本脚本/套件的
// 说明，引用数即由 28 变 29，该门禁立刻红。新增测试若确需在文档中登记，**必须同批把
// `REFERENCE_COUNT_BASELINE` 改为新值**并在回传说明原因；若只是想让人知道有这个门禁，改 README 即可
// （README 不受该棘轮约束，且已写明本脚本与守护测试的路径）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// desktop/scripts/ → desktop/ → 仓库根
const ROOT = path.resolve(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '..');
const ECOSYSTEM = path.join(ROOT, 'ecosystem');

function readJson(file) {
  const abs = path.join(ECOSYSTEM, file);
  if (!fs.existsSync(abs)) throw new Error(`生态文件缺失：${abs}`);
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new Error(`生态文件 JSON 解析失败：${abs} — ${err.message}`);
  }
}

// 口径 2/3 的执行点：顶层类型必须与预期一致，否则抛错而不是返回 undefined。
// 抛错而非静默 0，是为了让「结构变了」变成一次可见的失败，而不是一个悄悄变小的数字。
function arrayAt(doc, pointer, file) {
  const arr = pointer ? pointer.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), doc) : doc;
  if (!Array.isArray(arr)) {
    throw new Error(
      `口径失效：${file} 的 ${pointer || '(顶层)'} 不是数组（实际 ${arr === undefined ? 'undefined' : typeof arr}）。` +
      '若该文件结构变更，请同步更新本脚本与 README 口径说明，不要用 `>=` 或兜底 0 掩盖。',
    );
  }
  return arr;
}

export function collectEcosystemCounts() {
  // 口径 1：一级子目录
  const skillsDir = path.join(ECOSYSTEM, 'skills');
  if (!fs.existsSync(skillsDir)) throw new Error(`技能目录缺失：${skillsDir}`);
  const skills = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .length;

  // 口径 2：顶层是对象，取 .connectors
  const mcpFile = 'mcp-connectors.json';
  const mcp = arrayAt(readJson(mcpFile), 'connectors', mcpFile).length;

  // 口径 3：顶层是数组
  const roleFile = 'digital-employees.json';
  const digitalEmployees = arrayAt(readJson(roleFile), '', roleFile).length;

  const total = skills + mcp + digitalEmployees;

  // 参照口径（不计入 total）：WorkBuddy 原始导入清单
  let workbuddyRaw = null;
  try {
    const wbFile = 'mcp-connectors-workbuddy.json';
    workbuddyRaw = arrayAt(readJson(wbFile), 'connectors', wbFile).length;
  } catch {
    // 该文件是可选导入件，缺失不应阻断主口径计算
    workbuddyRaw = null;
  }

  return { skills, mcp, digitalEmployees, total, workbuddyRaw, excludedFromTotal: workbuddyRaw != null ? [ 'mcp-connectors-workbuddy.json' ] : [] };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const counts = collectEcosystemCounts();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(counts, null, 2));
  } else {
    console.log('生态资产计数（源码现算）');
    console.log(`  skills              = ${counts.skills}   （ecosystem/skills/ 一级子目录）`);
    console.log(`  mcp connectors      = ${counts.mcp}   （ecosystem/mcp-connectors.json → .connectors）`);
    console.log(`  digital employees   = ${counts.digitalEmployees}   （ecosystem/digital-employees.json 顶层数组）`);
    console.log(`  ─────────────────────────────`);
    console.log(`  合计                = ${counts.total}`);
    if (counts.workbuddyRaw != null) {
      console.log(`\n  不计入合计：mcp-connectors-workbuddy.json → .connectors = ${counts.workbuddyRaw}`);
      console.log('  （WorkBuddy 原始导入清单，与精选清单零重叠，两套独立命名空间，运行时不合并去重）');
    }
    console.log('\nJSON:');
    console.log(JSON.stringify(counts));
  }
}

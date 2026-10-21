// 测试基线汇总口径（C-04，2026-10-21 从 run-all.mjs 抽出）
//
// 为什么要单独成模块：原来的汇总是一行内联表达式
//     `通过 = suites.length + GATES.length - failed.length`
// 它把「跳过」算进了「通过」——darwin 上 3 个沙箱套件从未真跑，汇总却报「通过 259 · 失败 0」。
// 这正是本项目反复记录的**假绿形态**：用「没验」冒充「验过」。而内联表达式无法被单测覆盖，
// 所以只能靠「读代码发现」；抽成纯函数后可以用真实输入把每种边界都钉住。
//
// 三条口径（改动前只有前两条）：
//   ① 总计 = 套件 + 前置门禁
//   ② 失败 = 非零退出的项（含崩溃/超时）
//   ③ **跳过 = 报告了「⚠ 跳过 / 未执行」的套件**（按套件去重：一个套件可能有多行 ⚠）
//
// 关键取舍：
//   · 跳过 **不影响退出码** —— 平台限制不是缺陷，把 darwin 上跑不了 Linux 沙箱判成失败等于逼人删测试；
//   · 但跳过 **必须从「通过」里扣掉** —— 否则数字在骗人；
//   · 一个套件**既失败又报告跳过**时只算失败（不双重扣减），否则等式 `通过+失败+跳过=总计` 会破。

/**
 * @param {object} input
 * @param {number} input.total  检查项总数（套件 + 前置门禁）
 * @param {string[]} input.failed 失败项标识（套件路径或门禁 label）
 * @param {string[]} input.skipLines 套件输出里匹配「⚠ … 跳过/未执行」的**行**
 * @param {(line:any)=>string} [input.suiteOfLine] 从 skipLine 取套件标识（缺省读 `.suite`）
 * @returns {{total:number, passed:number, failed:number, skipped:number, skippedSuites:string[], ok:boolean}}
 *   ok=false 表示等式自洽校验失败（公式本身坏了，不是被测代码坏了）
 */
export function summarize({ total, failed = [], skipLines = [], suiteOfLine = (l) => l && l.suite } = {}) {
  const failedList = [...new Set(failed.map(String))];
  // 去重：同一套件可能打印多行 ⚠（如多平台各一行），按套件只算一次
  const skippedSuites = [...new Set(skipLines.map((l) => String(suiteOfLine(l) || '')).filter(Boolean))];
  // 既失败又跳过的，只计失败（否则同一项被扣两次，等式会破）
  const skipOnly = skippedSuites.filter((s) => !failedList.includes(s));
  const passed = Number(total) - failedList.length - skipOnly.length;
  const ok = passed >= 0 && passed + failedList.length + skipOnly.length === Number(total);
  return {
    total: Number(total),
    passed,
    failed: failedList.length,
    skipped: skipOnly.length,
    skippedSuites: skipOnly,
    ok,
  };
}


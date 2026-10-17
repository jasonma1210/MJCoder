'use strict';
// P1-2：工具超时的单一事实来源（main 侧「实现层」+ 引擎「看门狗层」的对账基准）
//
// 问题（审查实证）：三处超时数字互不自洽 ——
//   · shell 实现侧默认 60s（exec.js）
//   · web_fetch 实现侧 15s（webTools.js）
//   · 引擎看门狗 shell 600s / web_fetch 60s（agent-core TOOL_TIMEOUT_OVERRIDES）
// 引擎允许 600s，实现侧 60s 就自己断了 ⇒ **引擎的超时表是空转的**，永远轮不到它报错。
//
// 不变式（三层超时的通用约束）：实现侧 < 传输侧 < 任务侧，且上层超时要能拿到下层的真实原因。
// 因此本文件给出成对数值：IMPL（实现侧自断）与 WATCHDOG（引擎看门狗），并保持严格大于关系。
//
// 接线状态：
//   · main/tools/exec.js  ← SHELL_DEFAULT_TIMEOUT_MS（本次接线）
//   · main/webTools.js    ← WEB_FETCH_IMPL_TIMEOUT_MS（本次接线）
//   · agent-core/index.js 的 TOOL_TIMEOUT_OVERRIDES 需引用同名语义值（WP-A 负责接线；
//     引擎不得 require main/，故那边保留同值常量 + 由 test 对账，避免引擎依赖宿主目录）。

/** shell 实现侧默认超时（8min）：覆盖长构建 / 全量测试的最长档，留 2 倍于常见 CI */
const SHELL_DEFAULT_TIMEOUT_MS = 480000;
/** shell 引擎看门狗（10min）：严格大于实现侧，留 120s 余量给「实现层报错 + 结果回收」 */
const SHELL_WATCHDOG_TIMEOUT_MS = 600000;
/** web_fetch 实现侧（30s）：DNS + TLS + 首字节 + 2MB 正文的 P99 */
const WEB_FETCH_IMPL_TIMEOUT_MS = 30000;
/** web_fetch 引擎看门狗（60s）：与实现侧保持 2 倍关系 */
const WEB_FETCH_WATCHDOG_TIMEOUT_MS = 60000;

module.exports = {
  SHELL_DEFAULT_TIMEOUT_MS,
  SHELL_WATCHDOG_TIMEOUT_MS,
  WEB_FETCH_IMPL_TIMEOUT_MS,
  WEB_FETCH_WATCHDOG_TIMEOUT_MS,
};

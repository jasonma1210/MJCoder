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

// ── 工具组实现侧超时（P3 收口：原先 5 处散落在 exec.js 里的字面量）──
// 这些值本身没变，集中到这里是为了「改超时只改一处」——散落字面量的问题是
// 调一个数时永远不知道还有几处需要同步（与 P1-2 的三处不自洽同源）。
/** apply_patch 执行（30s）：本地补丁应用，超时按失败返回而非挂死 */
const PATCH_IMPL_TIMEOUT_MS = 30000;
/** grep 检索（15s）：仓库级单次检索的 P99 */
const GREP_IMPL_TIMEOUT_MS = 15000;
/** find 检索（20s）：比 grep 多 5s（遍历目录树比读文件慢） */
const FIND_IMPL_TIMEOUT_MS = 20000;
/** git 写/网络类（30s）：commit / clone / fetch */
const GIT_IMPL_TIMEOUT_MS = 30000;
/** git 轻量只读（8s）：status / rev-parse 这类本地瞬时命令 */
const GIT_QUICK_TIMEOUT_MS = 8000;

module.exports = {
  SHELL_DEFAULT_TIMEOUT_MS,
  SHELL_WATCHDOG_TIMEOUT_MS,
  WEB_FETCH_IMPL_TIMEOUT_MS,
  WEB_FETCH_WATCHDOG_TIMEOUT_MS,
  PATCH_IMPL_TIMEOUT_MS,
  GREP_IMPL_TIMEOUT_MS,
  FIND_IMPL_TIMEOUT_MS,
  GIT_IMPL_TIMEOUT_MS,
  GIT_QUICK_TIMEOUT_MS,
};

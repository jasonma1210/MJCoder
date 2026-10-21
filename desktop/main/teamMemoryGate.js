'use strict';
// 团队记忆沉淀闸（D-806 / B-12，2026-10-21 从 main.js 的 rememberTeamMemory 内联判断抽出）
//
// 为什么单独成模块：这个判断有**语义**（默认开、只有显式 false 才关、读偏好失败按开处理），
// 内联在闭包里只能靠源码形态断言，测不到行为。抽成纯函数后可以真正喂各种偏好取值。
//
// 为什么要与 `memory.autoCapture` 解耦（原实现两把闸共用一把）：
//   · 那把闸默认**关**，而「团队记忆」是军团的关键能力之一 ⇒ 默认配置下整条链空转，
//     功能等于不存在（B-12 的原话：「默认关闭 = 该能力默认不生效」）。
//   · 两件事的风险面也不同：主对话沉淀会把「不可信内容 → 模型结论 → 长期记忆 → 后续 prompt」
//     连成污染正反馈，所以要默认关；团队记忆只在团队内可见（跨团队严格隔离）、有
//     MAX_TEAM_MEMORIES=200 硬上限、来源是 model_conclusion（trust 0.6，排位靠后）、
//     归档团队只读 —— 默认开的暴露面小得多。
//   · 解耦后用户仍可单独关闭团队沉淀，而不必连坐全局自动沉淀（反之亦然）。
//
// 判据刻意写成「!== false 即开」而不是「=== true 即开」：
//   偏好从未设置过是常态（undefined），若按 === true 处理，默认就成了关，等于没解耦。
function teamCaptureEnabled(getPref) {
  if (typeof getPref !== 'function') return true;
  try {
    return getPref('memory.teamAutoCapture') !== false;
  } catch {
    // 读偏好失败按「开」处理：这是体验类能力，不是安全闸——读不到配置不该让功能静默消失。
    return true;
  }
}

module.exports = { teamCaptureEnabled };

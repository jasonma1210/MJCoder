// 「任务是否应恢复」的纯判定（跨宿主共享；渲染层与测试共用）
//
// 背景（A4，2026-10-16）：此前的续跑恢复靠**关键词匹配**——只有消息以「继续」或「continue」
// 开头才去读取断点。后果：
//   · 用户说「接着做」「接下来呢」「刚才那个继续」→ 静默不恢复，用户以为断点丢了；
//   · 反之，断点存在但用户换了说法 → 明明可恢复却被忽略。
//
// 正确语义是**状态驱动**：断点只在「单任务 token 预算闸挂起」或「引擎进程异常退出」时写入，
// 并在成功消费后清除。因此「本会话存在断点」≈「上一轮被中断」，这正是需要注入恢复上下文的
// 充分条件——与用户这轮说了什么无关。
//
// 关键词因此降级为**辅助信号**：仅用于「用户表达了继续意图、但本会话并无断点」这一情形，
// 供 UI/日志解释「为什么没有恢复」，而不再作为恢复的开关。

/** 继续意图的辅助识别（不用于放行恢复，只用于解释与提示） */
// 不做行首限定：旧实现要求消息以「继续/continue」**开头**，导致「请继续」「接着做」全部漏判。
// 这里用包含匹配；它只是辅助信号，不参与任何安全或恢复决策，误报代价仅是一条日志。
const CONTINUE_PATTERN = /(继续|接着|接下来|往下做|往下|go\s*on|continue|resume|carry\s*on)/i;

/**
 * 判断消息是否表达了「继续上一轮」的意图（辅助信号）。
 * @param {unknown} messageText
 * @returns {boolean}
 */
export function looksLikeContinue(messageText) {
  return CONTINUE_PATTERN.test(String(messageText == null ? '' : messageText));
}

/**
 * 恢复决策：**是否恢复只取决于是否存在断点**，不取决于关键词。
 * @param {{hasCheckpoint?: boolean, messageText?: unknown}} params
 * @returns {{resume: boolean, looksLikeContinue: boolean, reason: 'checkpoint'|'keyword-no-checkpoint'|'no-checkpoint'}}
 */
export function resumeDecision({ hasCheckpoint, messageText } = {}) {
  const has = hasCheckpoint === true;
  const intent = looksLikeContinue(messageText);
  return {
    resume: has,
    looksLikeContinue: intent,
    reason: has ? 'checkpoint' : (intent ? 'keyword-no-checkpoint' : 'no-checkpoint'),
  };
}

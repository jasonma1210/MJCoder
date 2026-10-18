'use strict';
// 定时通道的「对外动作」闸门 —— 产物形态即校验。
//
// 为什么需要（行业口径）：主流后台 Agent 的真正保障不是「事后判分」，而是**不让不可逆动作
// 自动发生**——编码 Agent 的产物是 PR（人不 merge 就不生效），ChatGPT 的计划任务遇到需要
// 授权的动作直接暂停等人。我们原来只做了「事后判分 + 不宣告成功」，档不住的正是
// **已经推出去的 commit / 已经发出去的消息**。
//
// 本模块的做法：定时任务默认**拦截**对外/不可逆工具，把被拦的调用记成「待确认动作清单」，
// 随产物一起归档；人早上看到清单，自己手工执行或改任务设置放行。
//
// 边界（刻意划清）：
//   · 只拦「对外/不可逆」：本地写文件、读、搜索、git 只读命令一律放行 —— 那是任务的产物本身，
//     拦掉等于让定时任务没法干活。
//   · MCP 一律拦：外部服务的读写无法从工具名可靠区分，宁可让用户显式放开。
//   · 拦截返回的是**结构化失败**而不是抛错：模型要能读懂「这件事没做，请写进摘要」，
//     否则它会换着法子重试，把 200k token 预算烧在同一个动作上。
const { shellIsExternal } = require('./verifyPolicy');

// handler 键（camelCase）→ 策略名（snake_case）。两边命名不同是历史原因，
// 这里显式建表而不是靠字符串变换，避免 `prList` 被误判成 `pr_list` 一类的静默漏拦。
const BLOCKED = new Map([
  ['gitCommit', 'git_commit'],
  ['gitAdd', 'git_add'],
  ['mcpCallTool', 'mcp__call'],
  ['prReview', 'pr_review'],
  ['prComment', 'pr_comment'],
]);

function blockedReason(handlerKey, args) {
  const as = BLOCKED.get(handlerKey);
  if (as) return `对外动作 ${as} 在定时任务中默认不执行`;
  if (handlerKey === 'shell' && shellIsExternal(args?.command)) {
    return '命令含对外/破坏性操作（推送、删除、对外写），在定时任务中默认不执行';
  }
  return '';
}

// 把被拦动作还原成人能照着执行的一行文本（归档 md 里要能直接照抄）
function describe(handlerKey, args) {
  if (typeof args?.command === 'string') return args.command.slice(0, 300);
  if (handlerKey === 'gitCommit' && args?.message) {
    return `git commit -m ${JSON.stringify(String(args.message).slice(0, 120))}`;
  }
  if (handlerKey === 'mcpCallTool') return String(args?.tool || args?.name || '');
  return '';
}

/**
 * createScheduledGuard({ enabled })
 *   enabled=false 时 wrap 原样返回（任务显式设为 allow）。
 * 返回 { wrap(handlers), take() }
 *   take() 取出并清空待确认清单，供宿主写进运行记录。
 */
function createScheduledGuard({ enabled = true } = {}) {
  const pending = [];
  // 同一动作重复被拦只记一次（模型常会重试 2–3 次），否则清单里全是同一条
  const seen = new Set();

  function record(handlerKey, args) {
    const cmd = describe(handlerKey, args);
    const key = `${handlerKey}::${cmd || JSON.stringify(args || {}).slice(0, 120)}`;
    if (seen.has(key)) return;
    seen.add(key);
    pending.push({
      tool: BLOCKED.get(handlerKey) || handlerKey,
      command: cmd,
      at: Date.now(),
    });
  }

  return {
    enabled,
    wrap(handlers) {
      if (!enabled || !handlers || typeof handlers !== 'object') return handlers;
      const out = {};
      for (const [key, fn] of Object.entries(handlers)) {
        if (typeof fn !== 'function') { out[key] = fn; continue; }
        out[key] = async (args, ctx) => {
          const why = blockedReason(key, args);
          if (!why) return fn(args, ctx);
          record(key, args);
          return {
            ok: false,
            blocked: true,
            error: `SCHEDULED_BLOCKED: ${why}。已记入「待确认动作清单」，请勿重试，`
              + '改为在最终摘要里说明这一步需要用户手动确认。',
          };
        };
      }
      return out;
    },
    take() {
      const list = pending.slice();
      pending.length = 0;
      seen.clear();
      return list;
    },
  };
}

module.exports = { createScheduledGuard, blockedReason, describe, BLOCKED };

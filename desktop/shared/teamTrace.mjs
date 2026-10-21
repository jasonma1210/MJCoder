// M5 / T5-6：任务处理轨迹的展示口径（对话内协同卡与看板共用，单一事实来源）。
//
// 背景（2026-10-21 真机反馈）：派活后任务只显示「执行中」，用户看不到成员到底做了什么。
// 主进程已把 task_events 投影成只读事件数组随 run 下发；渲染侧的「事件 → 可读文案」规则
// 放在这里，避免 TeamRunStream 与 TeamBoard 各写一份导致同一条轨迹在两处文案不一致。
//
// 约定：
//   · 事件 payload 只含渲染最小字段（textKey/textParams/kind/text/status/name/error），不含正文；
//   · 文案优先 textKey（按当前语言翻译），status 事件走任务状态词表；
//   · 未知状态/未知事件一律回落原文，不隐藏（可排查优先于好看）。

/** 任务状态 → i18n key（fail-closed：未知状态显示原文）。 @type {Record<string, string>} */
export const TASK_STATUS_KEY = {
  pending: 'teams.streamTaskPending',
  queued: 'teams.streamTaskQueued',
  running: 'teams.streamTaskRunning',
  waiting: 'teams.streamTaskWaiting',
  done: 'teams.streamTaskDone',
  failed: 'teams.streamTaskFailed',
  skipped: 'teams.streamTaskSkipped',
};

/**
 * 轨迹事件 → 可读文本。
 * @param {(key: string, params?: Record<string, string | number>) => string} t 翻译函数
 * @param {{ type: string, payload: Record<string, unknown> | null }} evt 归一化事件
 */
export function taskEventText(t, evt) {
  const p = evt?.payload || {};
  if (evt?.type === 'status') {
    const key = TASK_STATUS_KEY[String(p.status || '')];
    return `${t('teams.streamTraceStatus')} ${key ? t(key) : (p.status || '')}`;
  }
  if (p.textKey) {
    const params = p.textParams && typeof p.textParams === 'object' ? p.textParams : undefined;
    return t(p.textKey, params);
  }
  return String(p.text || p.kind || '');
}

/** 轨迹时间戳：只显示时分秒（同一次 run 内日期信息对排查无增益）。 */
export function timeLabel(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 引用是否像文件路径：只有路径才能点击打开（纯 id / 标识保持只读文本）。 */
export function isPathLike(s) {
  return /^(?:\/|\.{1,2}\/|[A-Za-z]:[\\/])/.test(String(s || '')) || /[\\/]/.test(String(s || ''));
}

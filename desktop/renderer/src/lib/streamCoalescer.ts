// 流式增量合帧器（X11）
//
// 问题：模型流式输出时每个 token 都会触发一次 setState，进而让整条消息流重渲染，
// 并把正在增长的 markdown 整段重新解析。30–60 tok/s 就是每秒几十次全量解析，
// 长会话能明显感到发涩。
//
// 做法：把同一帧内的增量合并成一次提交。文本内容完全不变，改变的只是「什么时候画」。
// `shouldCommit` 在提交时再判定一次——运行结束后界面会清空流式文本，此时若有一个
// 迟到的 flush 落地，旧文本会被写回去，出现一条永不消失的幽灵消息。

export type Unsubscribe = () => void;

export interface Coalescer<T> {
  (value: T): void;
  /** 立即提交（测试/收尾用），幂等 */
  flushNow(): void;
  /** 丢弃待提交值（切换会话等场景） */
  cancel(): void;
}

export function makeCoalescer<T>(
  commit: (value: T) => void,
  shouldCommit: () => boolean = () => true,
): Coalescer<T> {
  let hasPending = false;
  let pending: T;
  let scheduled = false;

  const flush = (): void => {
    scheduled = false;
    if (!hasPending) return;
    if (!shouldCommit()) {
      hasPending = false; // 丢弃，绝不把过期文本写回界面
      return;
    }
    const value = pending;
    hasPending = false;
    commit(value);
  };

  const push = ((value: T) => {
    pending = value;
    hasPending = true;
    if (scheduled) return;
    scheduled = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    // 后台标签页 rAF 会被暂停；补一个兜底定时器（flush 幂等）
    setTimeout(flush, 120);
  }) as Coalescer<T>;

  push.flushNow = flush;
  push.cancel = () => { hasPending = false; };
  return push;
}

export default makeCoalescer;

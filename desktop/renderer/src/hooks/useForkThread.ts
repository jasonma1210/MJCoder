/**
 * P1-6：会话分支（fork）——消息上的「从此处分叉」按钮派发 mjcode:fork-thread
 * （CustomEvent，同 mjcode:open-settings 模式，避免层层传 prop）。
 *
 * 职责：调后端按分支点复制出独立新会话 → 切过去并刷新侧栏列表；源会话保持不变。
 *
 * 为什么抽成独立 hook：App.jsx 已贴着 800 行硬门禁（max-lines 基线），
 * 新增的事件注册逻辑不再内联（取舍同 useThreadModel）。
 */
import { useEffect } from 'react';
import { api } from '../lib/api';
import { toast } from '../components/feedback';
import { useI18n } from '../i18n';

interface ForkDetail {
  messageId?: number | null;
}
interface ForkResult {
  ok?: boolean;
  error?: string;
  thread: unknown;
}

export function useForkThread({
  activeThreadRef,
  onForked,
}: {
  /** App 层的最新会话 ref：闭包内读取，避免一次性注册时的陈旧引用 */
  activeThreadRef: { current: { id?: number } | null };
  onForked: (thread: unknown) => void;
}): void {
  const { t } = useI18n();
  useEffect(() => {
    const onFork = async (e: Event) => {
      const src = activeThreadRef.current;
      const messageId = (e as CustomEvent<ForkDetail>)?.detail?.messageId;
      if (!src?.id || messageId == null) return;
      try {
        const r = (await api.forkThread(src.id, messageId)) as ForkResult | undefined;
        if (!r?.ok) {
          toast({ message: r?.error || t('app.forkFailed') });
          return;
        }
        onForked(r.thread);
        toast({ message: t('app.forked') });
      } catch (err) {
        console.warn('[app] fork thread failed:', err);
        toast({ message: t('app.forkFailed') });
      }
    };
    window.addEventListener('mjcode:fork-thread', onFork);
    return () => window.removeEventListener('mjcode:fork-thread', onFork);
    // 一次性注册：体内经 activeThreadRef 读最新会话态，onForked 由调用方传入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

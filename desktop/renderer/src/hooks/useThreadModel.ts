/**
 * 把「当前选中的模型」与会话（thread）绑定起来。
 *
 * 三个必须成立的行为：
 *   1. 切到某个会话 → 恢复该会话自己的模型（不是上一个会话的）；
 *   2. 在某会话里换模型 → 只写回**这个**会话；
 *   3. 新会话（没有任何记录）→ 用「当前选中的模型」，并立刻写给它，保证下次回来还是它。
 *
 * 为什么恢复逻辑不写在 selectThread 里：selectThread 拿不到 providers（可能还没加载完），
 * 而且 App.jsx 已经贴着 800 行门禁，逻辑放 hook 里才能只加两行接线。
 *
 * 为什么**不**监听 selectedModel 自动写回（这是最容易踩的坑）：
 * 切会话时 React 会先用「新 threadId + 旧 selectedModel」渲染一次，若用 effect 监听
 * selectedModel 自动写回，就会把上一个会话的模型写进新会话，把新会话原有的记录冲掉；
 * 随后恢复逻辑再把正确值写一次，看起来「最终对了」，但中间那次覆盖已经造成丢数据
 * （用户切回来发现自己原来选的模型没了）。所以写回只走显式的 chooseModel。
 */
import { useCallback, useEffect, useRef } from 'react';
import { readThreadModel, resolveModel, writeThreadModel, planThreadSwitch, type ModelRef } from '../lib/threadModels';

type AnyProvider = { id?: string | number; models?: Array<Record<string, unknown>> };
type AnyModel = { provider?: { id?: string | number }; model?: { model_id?: string; modelId?: string } };

export function useThreadModel({
  threadId,
  providers,
  selectedModel,
  onRestore,
}: {
  threadId: string | null;
  providers: AnyProvider[];
  selectedModel: AnyModel | null;
  onRestore: (m: { provider: AnyProvider; model: Record<string, unknown> }) => void;
}): { chooseModel: (m: AnyModel | null) => void } {
  // providers / selectedModel 都可能在 effect 运行时是旧值，用 ref 取最新
  const providersRef = useRef(providers);
  providersRef.current = providers;
  const selectedRef = useRef(selectedModel);
  selectedRef.current = selectedModel;
  // 恢复失败但记录还在（供应商列表尚未加载完）→ 等 providers 就绪后补一次
  const pendingRef = useRef<{ threadId: string; ref: ModelRef } | null>(null);

  useEffect(() => {
    pendingRef.current = null;
    const saved = readThreadModel(threadId);
    const m = saved ? resolveModel(providersRef.current, saved) : null;
    // 决策交给纯函数（唯一分水岭，见 planThreadSwitch 的注释）
    const plan = planThreadSwitch({ threadId, saved, resolved: m, current: selectedRef.current });
    if (plan.type === 'restore' && m) onRestore(m);
    else if (plan.type === 'seed' && threadId) writeThreadModel(threadId, selectedRef.current);
    else if (plan.type === 'pending' && threadId && saved) pendingRef.current = { threadId, ref: saved };
    // onRestore 刻意不列入依赖：它每次渲染都是新函数，列进去会让恢复无限重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  // providers 加载完成（或供应商被增删）后，补试一次挂起的恢复
  useEffect(() => {
    const p = pendingRef.current;
    if (!p || p.threadId !== threadId) return;
    const m = resolveModel(providers, p.ref);
    if (m) {
      pendingRef.current = null;
      onRestore(m);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, threadId]);

  // 显式选择：先应用，再写回当前会话（只有这条路径会写，避免切会话时的覆盖竞争）
  const chooseModel = useCallback((m: AnyModel | null) => {
    if (!m) return;
    onRestore(m as { provider: AnyProvider; model: Record<string, unknown> });
    if (threadId) writeThreadModel(threadId, m);
    // onRestore 同上，不列依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  return { chooseModel };
}

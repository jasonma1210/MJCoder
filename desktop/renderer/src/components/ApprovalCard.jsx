import { useCallback, useRef, useState, useEffect } from 'react';
import { useI18n } from '../i18n'; // T3-2：i18n
import { IconAlert, IconFile, IconPlug, IconTerminal } from './icons';

// 顶层常量只存标题 key（求值推迟到渲染时经 t()，切换语言即时更新）
const LEVEL_META = {
  L1: { titleKey: 'approval.dangerTitle', Icon: IconTerminal, color: 'text-danger' },
  L2: { titleKey: 'approval.fileWriteTitle', Icon: IconFile, color: 'text-warn' },
  L3: { titleKey: 'approval.mcpTitle', Icon: IconPlug, color: 'text-info' },
};

// 审批卡片（对标 Codex）：不再全屏遮罩，改为右下角非模态悬浮
// 关键差异 —— 审批时对话流仍然可见可滚动，用户能对照上下文再决定，而不是被强制切走
// A7：主行动改「允许一次」（accent 实心），「始终允许」降为边框按钮置末位（视觉语义不再倒置）
// B16：键盘 1=拒绝 2=允许一次 3=本对话 4=始终允许
// P1-D：审批挂起/决策上报 onPendingChange（App 据此置线程状态 awaiting_approval/running）；
//       监听 mjcode:focus-approval（侧栏「N 待审批」徽标点击）→ 展开并高亮闪现
//
// 2026-10-15 修复：待审批改为 **FIFO 队列**。
// 事故背景：原实现只有一个 pending 槽位。自动 DAG 下多个 Worker 并发申请审批时，
// 新请求直接覆盖旧的——被覆盖的那条在界面上再也点不到，只能等主进程 120s 超时按
// 拒绝收尾；用户看到的现象是「卡片弹了但命令继续执行，点了又没反应」。
// 现在每条审批都进队，逐条作答，并显示「第 i/N 条」让用户知道后面还有几条。
export default function ApprovalCard({ onPendingChange }) {
  const { t } = useI18n();
  const [queue, setQueue] = useState([]);
  const [collapsed, setCollapsed] = useState(false);
  const [flash, setFlash] = useState(false);
  // 回调走 ref：避免父组件每次渲染传入新函数导致审批监听重复订阅
  const pendingCbRef = useRef(onPendingChange);
  pendingCbRef.current = onPendingChange;

  // 当前展示的永远是队首（FIFO），保证先申请的先被回答
  const pending = queue[0] || null;

  useEffect(() => {
    if (!window.mjcode?.onApprovalRequest) return undefined;
    const off = window.mjcode.onApprovalRequest((req) => {
      if (!req?.approvalId) return; // 无 id 的请求无法回传决策，丢弃（主进程按 id 分发）
      setQueue((q) => (q.some((r) => r.approvalId === req.approvalId) ? q : [...q, req]));
      setCollapsed(false);
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  // 审批结束回执：已决策 / 超时 / 窗口销毁 —— 撤下对应卡片。
  // 没有它，超时后的卡片会一直挂着，用户点击时主进程已无该 pending，
  // 只能记「收到无法匹配的审批响应，已忽略」。
  useEffect(() => {
    if (!window.mjcode?.onApprovalEnd) return undefined;
    const off = window.mjcode.onApprovalEnd(({ approvalId } = {}) => {
      if (!approvalId) return;
      setQueue((q) => q.filter((r) => r.approvalId !== approvalId));
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  // 队列空/非空变化时上报（App 据此置线程状态）
  useEffect(() => {
    pendingCbRef.current?.(queue.length > 0);
  }, [queue.length]);

  // P1-D：侧栏徽标点击直达——展开卡片并短暂高亮（不切换视图，保持当前上下文可见）
  useEffect(() => {
    const onFocus = () => {
      setCollapsed(false);
      setFlash(true);
      setTimeout(() => setFlash(false), 1200);
    };
    window.addEventListener('mjcode:focus-approval', onFocus);
    return () => window.removeEventListener('mjcode:focus-approval', onFocus);
  }, []);

  // P1-6：resolve 包 useCallback。它原先是无记忆的普通函数，每次渲染新建引用；
  // 一旦被 useEffect 列入依赖（键盘处理器需要它），就会让监听每轮渲染卸载重挂。
  // 依赖只有 pending（其余是稳定 setter 与 ref），与键盘 effect 的触发条件一致。
  const resolve = useCallback((decision) => {
    if (!pending?.approvalId) return;
    // P0-2：决策负载必须回带 approvalId——主进程按 id 精确分发，
    // 并发审批时决策才能落到正确的请求上（否则把「允许」发给另一条命令）
    window.mjcode.resolveApproval({ approvalId: pending.approvalId, decision });
    // 乐观出队：主进程的 tool:approval-end 回执到达时会再过滤一次，幂等
    setQueue((q) => q.filter((r) => r.approvalId !== pending.approvalId));
  }, [pending]);

  // 键盘 1-4 快捷决策（仅审批卡非折叠时生效）
  useEffect(() => {
    if (!pending || collapsed) return undefined;
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // 输入焦点守卫：用户正在输入框打字（内容里出现数字 1-4 很常见）时
      // 不得触发审批决策，否则一句「方案 1 不错」就会误拒/误批
      const el = e.target;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (typing) return;
      const map = { 1: 'deny', 2: 'once', 3: 'conversation', 4: 'always' };
      if (map[e.key]) {
        e.preventDefault();
        resolve(map[e.key]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // P1-6：resolve 必须列入依赖。此前遗漏 → 父组件传入新的 resolve（如审批卡因
    // 新一轮审批重建）时，键盘处理器仍闭包着旧的 resolve，用户按 Enter/Esc 的决策
    // 会送到已失效的 Promise 上，表现为「按了键但审批毫无反应」。
  }, [pending, collapsed, resolve]);

  if (!pending) return null;
  const meta = LEVEL_META[pending.level] || LEVEL_META.L2;
  const total = queue.length;

  return (
    <div className={`fixed bottom-14 right-4 w-[460px] max-w-[calc(100vw-2rem)] z-approval transition-shadow${flash ? ' ring-2 ring-accent rounded-2xl' : ''}`}>
      <div className="bg-surface border border-warn rounded-2xl shadow-[var(--shadow-pop)] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <span className={meta.color}><meta.Icon size={15} /></span>
          <span className="text-sm font-medium">{t(meta.titleKey)}</span>
          <span className="text-text2 text-xs font-mono truncate">{pending.tool}</span>
          {total > 1 && (
            <span className="text-text2 text-xs shrink-0">{t('approval.queuePosition', { total })}</span>
          )}
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="ml-auto text-text2 hover:text-text text-xs"
          >
            {collapsed ? t('approval.expand') : t('approval.collapse')}
          </button>
        </div>

        {!collapsed && (
          <>
            {/* V21：显示审批请求来源的工作根（多会话/隔离工作区并发时，
                用户需要知道命令将作用在哪个目录）。主进程摘要未携带时不显示，不硬造。 */}
            {(pending.cwd || pending.workingRoot) && (
              <div className="flex items-center gap-2 px-4 pt-3 text-xs text-text2">
                <span className="shrink-0">{t('approval.workingRoot')}</span>
                <span className="font-mono truncate" title={pending.cwd || pending.workingRoot}>
                  {pending.cwd || pending.workingRoot}
                </span>
              </div>
            )}
            <pre className="px-4 py-3 text-xs font-mono overflow-x-auto max-h-40 whitespace-pre-wrap text-text2">
              {pending.detail || t('approval.noDetail')}
            </pre>
            <div className="flex flex-wrap gap-2 px-4 pb-3.5">
              <button onClick={() => resolve('once')}
                className="px-3 py-1.5 rounded-lg text-xs bg-accent text-white hover:opacity-90">{t('approval.allowOnce')}</button>
              <button onClick={() => resolve('conversation')}
                className="px-3 py-1.5 rounded-lg text-xs border border-border hover:bg-hover">{t('approval.allowConversation')}</button>
              <button onClick={() => resolve('deny')}
                className="px-3 py-1.5 rounded-lg text-xs border border-border hover:bg-hover">{t('approval.deny')}</button>
              <button onClick={() => resolve('always')}
                className="px-3 py-1.5 rounded-lg text-xs border border-border hover:bg-hover">{t('approval.allowAlways')}</button>
              <span className="text-[10px] text-text2 self-center ml-auto" title={t('approval.hotkeyTitle')}>{t('approval.hotkeyHint')}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import { useRef, useState, useEffect } from 'react';
import { IconAlert, IconFile, IconPlug, IconTerminal } from './icons';

const LEVEL_META = {
  L1: { label: '危险命令', Icon: IconTerminal, color: 'text-danger' },
  L2: { label: '文件写入', Icon: IconFile, color: 'text-warn' },
  L3: { label: 'MCP 工具', Icon: IconPlug, color: 'text-info' },
};

// 审批卡片（对标 Codex）：不再全屏遮罩，改为右下角非模态悬浮
// 关键差异 —— 审批时对话流仍然可见可滚动，用户能对照上下文再决定，而不是被强制切走
// A7：主行动改「允许一次」（accent 实心），「始终允许」降为边框按钮置末位（视觉语义不再倒置）
// B16：键盘 1=拒绝 2=允许一次 3=本对话 4=始终允许
// P1-D：审批挂起/决策上报 onPendingChange（App 据此置线程状态 awaiting_approval/running）；
//       监听 mjcode:focus-approval（侧栏「N 待审批」徽标点击）→ 展开并高亮闪现
export default function ApprovalCard({ onPendingChange }) {
  const [pending, setPending] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [flash, setFlash] = useState(false);
  // 回调走 ref：避免父组件每次渲染传入新函数导致审批监听重复订阅
  const pendingCbRef = useRef(onPendingChange);
  pendingCbRef.current = onPendingChange;

  useEffect(() => {
    if (!window.mjcode?.onApprovalRequest) return;
    const off = window.mjcode.onApprovalRequest((req) => {
      setPending(req);
      setCollapsed(false);
      pendingCbRef.current?.(true);
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

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

  function resolve(decision) {
    window.mjcode.resolveApproval(decision);
    setPending(null);
    pendingCbRef.current?.(false);
  }

  // 键盘 1-4 快捷决策（仅审批卡非折叠时生效）
  useEffect(() => {
    if (!pending || collapsed) return;
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
  }, [pending, collapsed]);

  if (!pending) return null;
  const meta = LEVEL_META[pending.level] || LEVEL_META.L2;

  return (
    <div className={`fixed bottom-14 right-4 w-[460px] max-w-[calc(100vw-2rem)] z-approval transition-shadow${flash ? ' ring-2 ring-accent rounded-2xl' : ''}`}>
      <div className="bg-surface border border-warn rounded-2xl shadow-[var(--shadow-pop)] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <span className={meta.color}><meta.Icon size={15} /></span>
          <span className="text-sm font-medium">{meta.label}确认</span>
          <span className="text-text2 text-xs font-mono truncate">{pending.tool}</span>
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="ml-auto text-text2 hover:text-text text-xs"
          >
            {collapsed ? '展开' : '收起'}
          </button>
        </div>

        {!collapsed && (
          <>
            <pre className="px-4 py-3 text-xs font-mono overflow-x-auto max-h-40 whitespace-pre-wrap text-text2">
              {pending.detail || '（无详情）'}
            </pre>
            <div className="flex flex-wrap gap-2 px-4 pb-3.5">
              <button onClick={() => resolve('once')}
                className="px-3 py-1.5 rounded-lg text-xs bg-accent text-white hover:opacity-90">允许一次</button>
              <button onClick={() => resolve('conversation')}
                className="px-3 py-1.5 rounded-lg text-xs border border-border hover:bg-hover">本对话同类允许</button>
              <button onClick={() => resolve('deny')}
                className="px-3 py-1.5 rounded-lg text-xs border border-border hover:bg-hover">拒绝</button>
              <button onClick={() => resolve('always')}
                className="px-3 py-1.5 rounded-lg text-xs border border-border hover:bg-hover">始终允许</button>
              <span className="text-[10px] text-text2 self-center ml-auto" title="键盘快捷键">1 拒绝 · 2 允许一次 · 3 本对话 · 4 始终允许</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

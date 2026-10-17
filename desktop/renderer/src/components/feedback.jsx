import { useEffect, useRef, useState } from 'react';
import { IconAlert, IconX } from './icons';
import { useI18n } from '../i18n';

// ── 命令式确认框 + Toast（A2 统一规格）──
// 用法（无需在各组件挂 state/JSX）：
//   import { confirm, toast } from './feedback';
//   if (await confirm({ title, message, danger: true })) { ... }
//   toast({ message: '已删除', actionLabel: '撤销', onAction });
// <FeedbackHost /> 在 App 根部挂载一次。

let confirmListener = null;
let toastListener = null;
let confirmSeq = 0;

export function confirm(opts = {}) {
  if (!confirmListener) {
    console.warn('[feedback] FeedbackHost not mounted; confirm resolved as cancel');
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    confirmListener({ id: ++confirmSeq, ...opts, resolve });
  });
}

// countConfirm：高危批量操作需输入数量确认（如「全部放弃」N 个文件）
export function countConfirm(opts = {}) {
  return confirm({ ...opts, count: opts.count ?? 0 });
}

export function toast({ message, actionLabel, onAction, duration = 5000 }) {
  if (!toastListener) {
    console.warn('[feedback] FeedbackHost not mounted; toast dropped:', message);
    return;
  }
  toastListener({ id: ++confirmSeq, message, actionLabel, onAction, duration });
}

export default function FeedbackHost() {
  // 本文件 toast 回调参数名为 t（提示项），解构改名 tr 避免遮蔽
  const { t: tr } = useI18n();
  const [dialog, setDialog] = useState(null);   // { title, message, danger, count, resolve }
  const [countInput, setCountInput] = useState('');
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    confirmListener = (req) => {
      setCountInput('');
      setDialog(req);
    };
    toastListener = (t) => {
      setToasts((prev) => [...prev.slice(-3), t]); // 最多同屏 4 条
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
      }, t.duration || 5000);
    };
    return () => { confirmListener = null; toastListener = null; };
  }, []);

  // C2（2026-10-17）：领取「上次渲染进程崩溃」的通知（主进程取完即清）。
  // 放在提示系统里而不是 App：崩溃提示本质就是一条 toast，职责更贴；
  // 且 App.jsx 已贴到 800 行门禁，不宜再塞逻辑。
  // 必须排在上面的 effect 之后——它负责把 toastListener 挂上。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const notices = await window.mjcode?.getCrashNotice?.();
        if (cancelled || !Array.isArray(notices) || notices.length === 0) return;
        const isLoop = notices.some((n) => n && n.kind === 'loop');
        toast({
          message: isLoop ? tr('app.crashLoop', { n: notices.length }) : tr('app.crashRecovered'),
          duration: 8000,
        });
      } catch { /* 崩溃提示失败绝不影响启动 */ }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function finish(ok) {
    if (!dialog) return;
    dialog.resolve(ok);
    setDialog(null);
  }

  // Esc 关闭 = 取消（危险操作默认安全侧）
  // P1-6：finish 走 latest-ref 模式。finish 是组件内普通函数（每次渲染新建），
  // 直接列入依赖会让 keydown 监听每轮渲染卸载重挂；但遗漏又会用到过期闭包。
  // ref 方案两者兼顾：监听只在 dialog 开关时重挂，调用时永远是最新 finish。
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    if (!dialog) return;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); finishRef.current(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog]);

  function dismissToast(id) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  return (
    <>
      {dialog && (
        <div className="fixed inset-0 z-palette flex items-center justify-center bg-overlay" onMouseDown={() => finish(false)}>
          <div
            className="w-[420px] max-w-[calc(100vw-2rem)] rounded-2xl bg-raise border border-border shadow-[var(--shadow-modal)] p-5"
            onMouseDown={(e) => e.stopPropagation()}
            role="alertdialog"
            aria-modal="true"
            aria-label={dialog.title || tr('feedback.confirmFallback')}
          >
            <div className="flex items-start gap-3">
              {dialog.danger && (
                <span className="text-danger shrink-0 mt-0.5"><IconAlert size={18} /></span>
              )}
              <div className="flex-1">
                <div className="text-sm font-semibold">{dialog.title || tr('feedback.confirmFallback')}</div>
                <div className="text-xs text-text2 mt-1.5 leading-relaxed whitespace-pre-line">{dialog.message}</div>
                {dialog.count != null && (
                  <div className="mt-3">
                    <input
                      autoFocus
                      value={countInput}
                      onChange={(e) => setCountInput(e.target.value.replace(/\D/g, ''))}
                      placeholder={tr('feedback.countConfirmPlaceholder', { count: dialog.count })}
                      className="w-40 bg-bg border border-border rounded-lg px-3 py-1.5 text-sm outline-none focus:border-accent"
                      onKeyDown={(e) => { if (e.key === 'Enter' && Number(countInput) === dialog.count) finish(true); }}
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => finish(false)}
                className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-hover">{tr('feedback.cancel')}</button>
              <button
                onClick={() => finish(true)}
                disabled={dialog.count != null && Number(countInput) !== dialog.count}
                className={`text-xs px-3 py-1.5 rounded-lg disabled:opacity-40 ${dialog.danger ? 'bg-danger-solid text-on-accent hover:brightness-110' : 'bg-accent-solid text-on-accent hover:brightness-110'}`}
              >
                {dialog.confirmLabel || (dialog.danger ? tr('feedback.confirmDanger') : tr('feedback.confirm'))}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Toast 右下角（审批卡左上方错开，z-toast 位于 approval 之下） */}
      <div className="fixed bottom-14 left-1/2 -translate-x-1/2 z-toast flex flex-col gap-2 items-center pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto flex items-center gap-3 bg-raise border border-border rounded-xl shadow-[var(--shadow-pop)] px-4 py-2 text-xs">
            <span className="text-text">{t.message}</span>
            {t.actionLabel && (
              <button
                onClick={() => { t.onAction?.(); dismissToast(t.id); }}
                className="text-accent font-medium hover:opacity-80 shrink-0"
              >
                {t.actionLabel}
              </button>
            )}
            <button onClick={() => dismissToast(t.id)} className="text-text2 hover:text-text shrink-0" aria-label={tr('feedback.closeToast')}>
              <IconX size={12} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

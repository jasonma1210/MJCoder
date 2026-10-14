import { useEffect, useRef, useState } from 'react';
import { IconAlert, IconX } from './icons';

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
    console.warn('[feedback] FeedbackHost 未挂载，confirm 已按取消处理');
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
    console.warn('[feedback] FeedbackHost 未挂载，toast 被丢弃:', message);
    return;
  }
  toastListener({ id: ++confirmSeq, message, actionLabel, onAction, duration });
}

export default function FeedbackHost() {
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

  function finish(ok) {
    if (!dialog) return;
    dialog.resolve(ok);
    setDialog(null);
  }

  // Esc 关闭 = 取消（危险操作默认安全侧）
  useEffect(() => {
    if (!dialog) return;
    const onKey = (e) => { if (e.key === 'Escape') finish(false); };
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
            aria-label={dialog.title || '确认操作'}
          >
            <div className="flex items-start gap-3">
              {dialog.danger && (
                <span className="text-danger shrink-0 mt-0.5"><IconAlert size={18} /></span>
              )}
              <div className="flex-1">
                <div className="text-sm font-semibold">{dialog.title || '确认操作'}</div>
                <div className="text-xs text-text2 mt-1.5 leading-relaxed whitespace-pre-line">{dialog.message}</div>
                {dialog.count != null && (
                  <div className="mt-3">
                    <input
                      autoFocus
                      value={countInput}
                      onChange={(e) => setCountInput(e.target.value.replace(/\D/g, ''))}
                      placeholder={`输入 ${dialog.count} 以确认`}
                      className="w-40 bg-bg border border-border rounded-lg px-3 py-1.5 text-sm outline-none focus:border-accent"
                      onKeyDown={(e) => { if (e.key === 'Enter' && Number(countInput) === dialog.count) finish(true); }}
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => finish(false)}
                className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-hover">取消</button>
              <button
                onClick={() => finish(true)}
                disabled={dialog.count != null && Number(countInput) !== dialog.count}
                className={`text-xs px-3 py-1.5 rounded-lg disabled:opacity-40 ${dialog.danger ? 'bg-danger text-white hover:opacity-90' : 'bg-accent text-white hover:opacity-90'}`}
              >
                {dialog.confirmLabel || (dialog.danger ? '确认删除' : '确认')}
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
            <button onClick={() => dismissToast(t.id)} className="text-text2 hover:text-text shrink-0" aria-label="关闭提示">
              <IconX size={12} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

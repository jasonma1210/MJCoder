import { useEffect, useRef, useState } from 'react';
import { IconAlert, IconX } from './icons';
import { useI18n, tGlobal } from '../i18n';

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

  // P2-7（第二轮审查）：消费主进程的「执行后告知」通知。
  // 事件走既有 `tasks:event` 广播（approvalSettings 把 emitTaskEvent 注入成 sink），不新开通道。
  // 为什么挂在这里：本项目所有提示的出口都在本文件（confirm / toast），崩溃提示也在此；
  // 另起一套会出现两种提示样式，用户还要记两处。
  // 只订阅一次：文案在事件到达时才解析，语言切换后新通知用新语言（已在屏上的 toast 保持原样）。
  // ⚠️ 这里必须用 tGlobal，**不能用渲染期的 tr**（2026-10-18 实测缺陷）：
  // 本 effect 的依赖是 []，闭包捕获的是**首帧**的 tr；而 useI18n 的 t 在切语言时会换实体，
  // 于是「切语言后新通知用新语言」这句承诺实际上从未成立 —— 订阅永远说旧语言。
  // tGlobal 每次调用读 activeLocale，正是为这种非 React 回调场景准备的通道。
  useEffect(() => {
    const mj = typeof window !== 'undefined' ? window.mjcode : undefined;
    if (typeof mj?.onTasksEvent !== 'function') return undefined;
    let off;
    try {
      off = mj.onTasksEvent((evt) => {
        if (!evt || evt.type !== 'approval_notice') return;
        const result = evt.ok ? tGlobal('settings.approvalNoticeOk') : tGlobal('settings.approvalNoticeFail');
        const base = Number.isFinite(evt.ms)
          ? tGlobal('settings.approvalNoticeExecuted', { tool: evt.tool, level: evt.level || '-', result, ms: evt.ms })
          : tGlobal('settings.approvalNoticeExecutedNoMs', { tool: evt.tool, level: evt.level || '-', result });
        // 不可补偿必须明说 —— 这条通知的全部价值就在这里（不是「顺手告诉你一声」）
        const message = evt.reversible === false && evt.reversibleNote
          ? `${base} | ${tGlobal('settings.approvalNoticeIrreversible', { note: evt.reversibleNote })}`
          : base;
        toast({ message, duration: evt.reversible === false ? 8000 : 5000 });
      });
    } catch (e) {
      console.warn('[feedback] approval_notice subscribe failed:', e);
    }
    return () => { try { off?.(); } catch { /* 卸载失败无副作用 */ } };
    // 依赖保持 []：文案走 tGlobal（不捕获渲染期 tr），订阅本身不需要随语言重建
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

  // 开箱接管焦点（P3-F3）：ui/Modal 的「别人的对话框在接管键盘」判据要求
  // `document.activeElement` 落在对方弹层内（closest('[aria-modal],[role=dialog]')）。
  // 此前 confirm 打开时不 focus 任何元素 → 判据不成立 → 底层 Modal 会先吃掉 Esc
  // （第一下关掉底层浮层、第二下才取消确认框），Tab 也会跑到底层去。
  const dialogPanelRef = useRef(null);
  useEffect(() => {
    if (!dialog) return;
    // countConfirm 自带 autoFocus 的输入框（它本身就在弹层内），不要去抢
    if (dialog.count != null) return;
    dialogPanelRef.current?.focus();
  }, [dialog]);

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
            ref={dialogPanelRef}
            tabIndex={-1}
            className="w-[420px] max-w-[calc(100vw-2rem)] rounded-2xl bg-raise border border-border shadow-[var(--shadow-modal)] p-5 focus:outline-none"
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
                {/* danger 只表达**视觉强度**（红色 + 警告图标），不表达「删除」语义。
                    此前默认文案是「确认删除」，于是「允许对外动作」这类确认框也写着"确认删除"
                    （用户实测截图）。现在默认用中性「确认」，动作语义必须由调用方给 confirmLabel。 */}
                {dialog.confirmLabel || tr('feedback.confirm')}
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

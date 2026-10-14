// 内联提示条：替换原生 alert()，支持 info/warn/error 三级
import { IconAlert, IconCheck, IconX } from './icons';

export default function InlineAlert({ type = 'info', children, onDismiss }) {
  const styles = {
    info: 'border-border text-text2',
    warn: 'border-warn text-warn bg-warn-bg',
    error: 'border-danger text-danger bg-danger-bg',
  };
  const Icon = type === 'error' ? IconAlert : type === 'warn' ? IconAlert : IconCheck;
  return (
    <div className={`flex items-start gap-2 border rounded-lg px-3 py-2 text-xs ${styles[type] || styles.info}`} role="alert">
      <span className="mt-0.5 shrink-0"><Icon size={14} /></span>
      <div className="flex-1 leading-relaxed">{children}</div>
      {onDismiss && (
        <button onClick={onDismiss} className="shrink-0 hover:opacity-70" title="关闭">
          <IconX size={14} />
        </button>
      )}
    </div>
  );
}

import { estimateMessagesTokens } from '../../../agent-core/index.js';
import { useI18n } from '../i18n';

// 上下文用量圆环（对标 Codex 右上角圆环）
// 超 70% 时自动触发压缩，达到 100% 视为溢出
const AUTO_COMPACT_RATIO = 0.7;

export function contextUsageOf(messages, contextWindow = 128000) {
  const used = estimateMessagesTokens(messages || []);
  return { used, total: contextWindow, ratio: Math.min(1, used / contextWindow) };
}

export default function ContextRing({ usage, onClick, compacting }) {
  const { t } = useI18n();
  const { ratio } = usage;
  const pct = Math.round(ratio * 100);
  const r = 7;
  const c = 2 * Math.PI * r;
  const color = ratio >= 0.9 ? 'var(--sem-danger)' : ratio >= AUTO_COMPACT_RATIO ? 'var(--sem-warn)' : 'var(--sem-accent)';

  return (
    <button
      onClick={onClick}
      title={t('contextRing.title', { pct, used: usage.used, total: usage.total })}
      aria-label={t('contextRing.ariaLabel', { pct })}
      className="flex items-center gap-1.5 text-text2 hover:text-text shrink-0"
    >
      <svg width="20" height="20" viewBox="0 0 20 20" className="shrink-0">
        <circle cx="10" cy="10" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
        <circle
          cx="10" cy="10" r={r} fill="none"
          stroke={color} strokeWidth="2.5" strokeLinecap="round"
          strokeDasharray={`${c * ratio} ${c}`}
          transform="rotate(-90 10 10)"
        />
      </svg>
      <span className="text-[11px] tabular-nums">{compacting ? t('contextRing.compacting') : `${pct}%`}</span>
    </button>
  );
}
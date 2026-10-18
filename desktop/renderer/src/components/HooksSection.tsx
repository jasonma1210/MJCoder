// P1-5：用户自定义生命周期 hooks 设置分区（preToolUse / postToolUse）。
// 背景：能力落在主进程 main/toolHooks.js，配置存 userData/hooks.json；渲染层此前零入口——
// 「有 hooks 能力」与「用户能用上 hooks」是两件事，本组件补上后者（列出 / 增删 / 启停 / 保存）。
//
// 交互取舍：
//   ① 表单直接编辑内存态，点「保存」才落盘（hooks.json 是一次全量覆盖写，逐条写会让半成品配置生效）；
//   ② 命令是一行 shell 文本，不提供「选择文件」对话框——用户脚本可能来自任意位置，
//      且 hooks.json 本身可由用户直接手改（路径在页面上明示，便于进阶用户走文件通道）。
import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../i18n';
import { Section, Input, Toggle } from './settings/shared';

interface HookRow {
  name: string;
  event: string;
  match: string;
  command: string;
  timeoutMs?: number;
  enabled?: boolean;
}

// IPC 返回：window.mjcode 为宽松 Record 类型，读取端须显式收窄（同 LocalMcpSection 约定）
interface HooksIpcResult {
  ok?: boolean;
  path?: string;
  hooks?: HookRow[];
  error?: string;
}

const EMPTY: HookRow = { name: '', event: 'preToolUse', match: '*', command: '', timeoutMs: 5000, enabled: true };

export default function HooksSection() {
  const { t } = useI18n();
  const [rows, setRows] = useState<HookRow[]>([]);
  const [draft, setDraft] = useState<HookRow>(EMPTY);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r = (await window.mjcode?.hooksGetConfig?.()) as HooksIpcResult | undefined;
      if (r?.ok) { setRows(Array.isArray(r.hooks) ? r.hooks : []); setPath(r.path || ''); }
      else setErr(t('settings.hooksLoadFailed'));
    } catch (e) {
      setErr(String((e as { message?: string })?.message || e));
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const patch = (i: number, p: Partial<HookRow>) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
    setMsg('');
  };
  const remove = (i: number) => {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
    setMsg('');
  };
  const add = () => {
    if (!draft.command.trim()) { setErr(t('settings.hooksCommandRequired')); return; }
    setErr('');
    setRows((prev) => [...prev, { ...draft, name: draft.name.trim() || draft.command.trim() }]);
    setDraft(EMPTY);
    setMsg('');
  };

  const save = async () => {
    setBusy(true); setMsg(''); setErr('');
    try {
      const r = (await window.mjcode?.hooksSetConfig?.({ hooks: rows })) as HooksIpcResult | undefined;
      if (r?.ok) { setRows(Array.isArray(r.hooks) ? r.hooks : rows); setMsg(t('settings.hooksSaved')); }
      else setErr(String(r?.error || t('settings.hooksSaveFailed')));
    } catch (e) {
      setErr(String((e as { message?: string })?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const rowCls = 'border-b border-border last:border-0 py-4';
  const labelCls = 'text-xs text-text2 mb-1';
  const eventLabel = (v: string) => (v === 'postToolUse' ? t('settings.hooksEventPost') : t('settings.hooksEventPre'));

  return (
    <Section title={t('settings.tabHooks')}>
      <div className="py-4">
        <p className="text-xs text-text2 leading-relaxed">{t('settings.hooksDesc')}</p>
        {path && <p className="text-xs text-text2 mt-2 break-all">{t('settings.hooksPathLabel', { path })}</p>}
      </div>

      {rows.length === 0 && (
        <div className="border-t border-border py-4 text-sm text-text2">{t('settings.hooksEmpty')}</div>
      )}

      {rows.map((r, i) => (
        <div key={`${r.name}-${i}`} className={`${rowCls} border-t`}>
          <div className="flex items-start gap-3">
            <span className="mt-1 shrink-0">
              <Toggle on={r.enabled !== false} label={t('settings.hooksEnable')}
                onChange={() => patch(i, { enabled: r.enabled === false })} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">{r.name}</div>
              <div className="text-xs text-text2 mt-1">{eventLabel(r.event)} · {r.match || '*'}</div>
              <code className="block text-xs text-text2 mt-1 break-all font-mono">{r.command}</code>
            </div>
            <button onClick={() => remove(i)}
              className="shrink-0 text-xs px-3 py-1 rounded-lg border border-border hover:bg-hover">
              {t('settings.hooksDelete')}
            </button>
          </div>
        </div>
      ))}

      <div className="border-t border-border py-4">
        <div className="text-sm font-medium mb-3">{t('settings.hooksAdd')}</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
          <div>
            <div className={labelCls}>{t('settings.hooksName')}</div>
            <Input value={draft.name} placeholder={t('settings.hooksNamePh')}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
          </div>
          <div>
            <div className={labelCls}>{t('settings.hooksEvent')}</div>
            <select value={draft.event}
              onChange={(e) => setDraft((d) => ({ ...d, event: e.target.value }))}
              className="w-full bg-input border border-border rounded-lg px-3 py-2 text-sm my-1 outline-none focus:border-accent">
              <option value="preToolUse">{t('settings.hooksEventPre')}</option>
              <option value="postToolUse">{t('settings.hooksEventPost')}</option>
            </select>
          </div>
          <div>
            <div className={labelCls}>{t('settings.hooksMatch')}</div>
            <Input value={draft.match} placeholder={t('settings.hooksMatchPh')}
              onChange={(e) => setDraft((d) => ({ ...d, match: e.target.value }))} />
          </div>
          <div>
            <div className={labelCls}>{t('settings.hooksTimeout')}</div>
            <Input value={String(draft.timeoutMs ?? 5000)} placeholder="5000"
              onChange={(e) => setDraft((d) => ({ ...d, timeoutMs: Number(e.target.value) || 0 }))} />
          </div>
        </div>
        <div className="mt-1">
          <div className={labelCls}>{t('settings.hooksCommand')}</div>
          <Input value={draft.command} placeholder={t('settings.hooksCommandPh')}
            onChange={(e) => setDraft((d) => ({ ...d, command: e.target.value }))} />
        </div>
        <p className="text-xs text-text2 mt-2 leading-relaxed">{t('settings.hooksStdinHint')}</p>
        <div className="flex items-center gap-3 mt-3">
          <button onClick={add}
            className="text-sm px-4 py-2 rounded-lg border border-border hover:bg-hover">
            {t('settings.hooksAddOne')}
          </button>
          <button onClick={save} disabled={busy}
            className="text-sm px-4 py-2 rounded-lg bg-accent text-white disabled:opacity-50">
            {busy ? t('settings.hooksSaving') : t('settings.hooksSave')}
          </button>
          {msg && <span className="text-xs text-text2">{msg}</span>}
          {err && <span className="text-xs text-danger">{err}</span>}
        </div>
      </div>
    </Section>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../i18n';

// T4-6：Mac 操作录制与回放面板（设置 → 浏览器与链接 → 计算机使用区）
// 录制 = 让 Agent（模型驱动）跑通一次任务并录成确定性脚本；
// 回放 = 不再调用模型，按脚本逐步重放，敏感步骤逐次确认。
// 纪律：录制数据仅存本机 userData/recordings/；面板不做任何永久放行。

type ModelOpt = { key: string; label: string; providerId: number; baseUrl: string; model: string };
type Recording = { id: string; name: string; objective: string; appName: string; createdAt: number; stepCount: number };
type CuaEvent = {
  type: string; mode?: string; step?: number;
  action?: { action?: string }; node?: { name?: string };
  summary?: string; message?: string; reason?: string;
  stepCount?: number; recordingId?: string;
};
type Approval = { title: string; detail: string; approvalId?: string };
type IpcResult = { ok: boolean; error?: string };

// preload 注入面（env.d.ts 的 mjcode 是宽泛 Record，这里按面板实际用到的收窄）
type Mj = {
  localProviders?: () => Promise<Array<{ id: number; name?: string; base_url?: string; modelId?: string; models?: Array<{ modelId: string; displayName?: string }> }>>;
  cuaRun?: (p: Record<string, unknown>) => Promise<IpcResult>;
  cuaStop?: () => Promise<IpcResult>;
  cuaReplay?: (p: { recordingId: string; approvalMode: string }) => Promise<IpcResult>;
  cuaRecordingsList?: () => Promise<{ ok: boolean; recordings?: Recording[] }>;
  cuaRecordingsDelete?: (p: { recordingId: string }) => Promise<IpcResult>;
  onCuaEvent?: (cb: (evt: CuaEvent) => void) => () => void;
  onCuaApprovalRequest?: (cb: (s: Approval) => void) => () => void;
  resolveCuaApproval?: (decision: string, approvalId?: string) => void;
  onCuaApprovalSettled?: (cb: (s: { approvalId?: string }) => void) => () => void;
};
const mj = (): Partial<Mj> => (window as unknown as { mjcode?: Mj }).mjcode ?? {};

export default function RecordReplayPanel({ granted }: { granted: boolean }) {
  const { t } = useI18n();
  const [form, setForm] = useState({ objective: '', appName: '', name: '', maxSteps: 15, modelKey: '' });
  const [models, setModels] = useState<ModelOpt[]>([]);
  const [running, setRunning] = useState<'record' | 'replay' | null>(null);
  const [events, setEvents] = useState<CuaEvent[]>([]); // 事件时间线（上限 60 条）
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [error, setError] = useState('');

  const refreshRecordings = useCallback(() => {
    mj().cuaRecordingsList?.()
      .then((r) => { if (r?.ok) setRecordings(r.recordings || []); })
      .catch((err) => console.warn('[cua] recordings list failed:', err));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const list = await mj().localProviders?.();
        const opts: ModelOpt[] = [];
        for (const p of list || []) {
          const ms = p.models || (p.modelId ? [{ modelId: p.modelId }] : []);
          for (const m of ms) {
            opts.push({
              key: `${p.id}|${m.modelId}`,
              label: `${p.name || p.id} · ${m.displayName || m.modelId}`,
              providerId: p.id,
              baseUrl: p.base_url || '',
              model: m.modelId,
            });
          }
        }
        setModels(opts);
        if (opts.length) setForm((f) => (f.modelKey ? f : { ...f, modelKey: opts[0].key }));
      } catch (err) { console.warn('[cua] model list failed:', err); }
    })();
    refreshRecordings();
  }, [refreshRecordings]);

  // CUA 事件流：录制/回放共用 'cua:event' 通道，按 mode 区分
  useEffect(() => {
    const off = mj().onCuaEvent?.((evt) => {
      setEvents((prev) => [...prev.slice(-59), evt]);
      if (evt.type === 'recorded') refreshRecordings();
      if (['done', 'stopped', 'error'].includes(evt.type)) {
        if (evt.type === 'error') setError(String(evt.message || ''));
        setRunning(null);
        setApproval(null);
      }
    });
    return () => off?.();
  }, [refreshRecordings]);

  // 逐次确认弹窗（录制与回放共用 'cua:approval-request'）
  // 2026-10-16：保存 approvalId 并在响应时回传。并发两个 CUA 确认时，
  // 主进程据此精确分发；不回传则由主进程走 dispatchLegacy（多挂起时拒绝猜测、按 deny）。
  useEffect(() => {
    const off = mj().onCuaApprovalRequest?.((summary) => setApproval(summary));
    const offSettled = mj().onCuaApprovalSettled?.((s) => {
      // 主进程已按超时/其他方式收尾：撤下卡片，否则用户看到「点了没反应」
      setApproval((cur) => (cur && cur.approvalId === s?.approvalId ? null : cur));
    });
    return () => { off?.(); offSettled?.(); };
  }, []);

  const resolveApproval = (decision: string) => {
    setApproval(null);
    mj().resolveCuaApproval?.(decision, approval?.approvalId);
  };

  const startRecord = async () => {
    setError('');
    setEvents([]);
    const opt = models.find((m) => m.key === form.modelKey);
    if (!form.objective.trim() || !form.appName.trim()) { setError(t('settings.cuaRecordNeedFields')); return; }
    if (!opt) { setError(t('settings.cuaRecordNeedModel')); return; }
    const r = await mj().cuaRun?.({
      objective: form.objective.trim(),
      appName: form.appName.trim(),
      recordingName: form.name.trim(),
      maxSteps: Math.min(50, Math.max(1, Number(form.maxSteps) || 15)),
      approvalMode: 'on-request',
      record: true,
      model: opt.model,
      providerId: opt.providerId,
      baseUrl: opt.baseUrl,
    });
    if (!r?.ok) { setError(String(r?.error || t('settings.cuaStartFailed'))); return; }
    setRunning('record');
  };

  const startReplay = async (rec: Recording, approvalMode: string) => {
    setError('');
    setEvents([]);
    const r = await mj().cuaReplay?.({ recordingId: rec.id, approvalMode });
    if (!r?.ok) { setError(String(r?.error || t('settings.cuaStartFailed'))); return; }
    setRunning('replay');
  };

  const stop = () => { mj().cuaStop?.(); };

  const removeRecording = async (id: string) => {
    const r = await mj().cuaRecordingsDelete?.({ recordingId: id });
    if (r?.ok) refreshRecordings(); else setError(String(r?.error || t('settings.cuaDeleteFailed')));
  };

  if (!granted) return null;

  const eventLine = (evt: CuaEvent) => {
    const mode = evt.mode === 'replay' ? t('settings.cuaModeReplay') : t('settings.cuaModeRecord');
    const map: Record<string, string> = {
      started: `${mode} ${t('settings.cuaEvtStarted')}`,
      step: `${mode} ${t('settings.cuaEvtStep')} ${evt.step}: ${evt.action?.action || ''}${evt.node?.name ? ` "${evt.node.name}"` : ''}`,
      confirm: `${mode} ${t('settings.cuaEvtConfirm')}`,
      fallback: `${mode} ${t('settings.cuaEvtFallback')}`,
      paused: `${mode} ${t('settings.cuaEvtPaused')}`,
      done: `${mode} ${t('settings.cuaEvtDone')}: ${evt.summary || ''}`,
      stopped: `${mode} ${t('settings.cuaEvtStopped')}: ${evt.reason || ''}`,
      recorded: `${t('settings.cuaEvtRecorded')}: ${evt.stepCount} ${t('settings.cuaEvtSteps')}`,
      error: `${t('settings.cuaEvtError')}: ${evt.message || ''}`,
    };
    return map[evt.type] || `${mode} ${evt.type}`;
  };

  return (
    <div className="mt-3 border border-border rounded-lg p-3 space-y-3">
      <p className="text-xs text-text2">{t('settings.cuaRecordIntro')}</p>

      {/* 录制表单 */}
      <div className="space-y-2">
        <textarea
          className="w-full bg-bg border border-border rounded px-2 py-1.5 text-sm"
          rows={2}
          placeholder={t('settings.cuaObjectivePlaceholder')}
          value={form.objective}
          onChange={(e) => setForm({ ...form, objective: e.target.value })}
          disabled={!!running}
        />
        <div className="flex gap-2">
          <input
            className="flex-1 bg-bg border border-border rounded px-2 py-1.5 text-sm"
            placeholder={t('settings.cuaAppNamePlaceholder')}
            value={form.appName}
            onChange={(e) => setForm({ ...form, appName: e.target.value })}
            disabled={!!running}
          />
          <input
            className="w-32 bg-bg border border-border rounded px-2 py-1.5 text-sm"
            placeholder={t('settings.cuaNamePlaceholder')}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            disabled={!!running}
          />
          <input
            className="w-16 bg-bg border border-border rounded px-2 py-1.5 text-sm"
            type="number" min={1} max={50}
            title={t('settings.cuaMaxStepsLabel')}
            value={form.maxSteps}
            onChange={(e) => setForm({ ...form, maxSteps: Number(e.target.value) })}
            disabled={!!running}
          />
        </div>
        <div className="flex gap-2 items-center">
          <select
            className="flex-1 bg-bg border border-border rounded px-2 py-1.5 text-sm"
            value={form.modelKey}
            onChange={(e) => setForm({ ...form, modelKey: e.target.value })}
            disabled={!!running}
          >
            {!models.length && <option value="">{t('settings.cuaNoModels')}</option>}
            {models.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
          {!running ? (
            <button className="px-3 py-1.5 text-sm bg-btn text-btnFg rounded hover:opacity-90" onClick={startRecord}>
              {t('settings.cuaStartRecord')}
            </button>
          ) : (
            <button className="px-3 py-1.5 text-sm border border-border rounded hover:bg-bg" onClick={stop}>
              {t('settings.cuaStop')}
            </button>
          )}
        </div>
      </div>

      {error && <p className="text-xs text-error">{error}</p>}

      {/* 逐次确认卡片：敏感动作必须当场确认，拒绝即停 */}
      {approval && (
        <div className="border border-warn rounded-lg p-2 space-y-1">
          <p className="text-sm text-warn">{approval.title}</p>
          <p className="text-xs text-text2 whitespace-pre-line">{approval.detail}</p>
          <div className="flex gap-2 pt-1">
            <button className="px-2 py-1 text-xs bg-btn text-btnFg rounded" onClick={() => resolveApproval('once')}>
              {t('settings.cuaApproveOnce')}
            </button>
            <button className="px-2 py-1 text-xs border border-border rounded" onClick={() => resolveApproval('deny')}>
              {t('settings.cuaDeny')}
            </button>
          </div>
        </div>
      )}

      {/* 事件时间线 */}
      {events.length > 0 && (
        <div className="max-h-40 overflow-y-auto border border-border rounded p-2 space-y-0.5">
          {events.map((e, i) => (
            <p key={i} className={`text-xs ${e.type === 'error' ? 'text-error' : 'text-text2'}`}>{eventLine(e)}</p>
          ))}
        </div>
      )}

      {/* 录制列表：回放 / 逐步确认回放 / 删除 */}
      <div className="space-y-1">
        <p className="text-xs text-text2">{t('settings.cuaRecordingsTitle')}</p>
        {!recordings.length && <p className="text-xs text-text2">{t('settings.cuaNoRecordings')}</p>}
        {recordings.map((rec) => (
          <div key={rec.id} className="flex items-center gap-2 border border-border rounded px-2 py-1.5">
            <div className="flex-1 min-w-0">
              <p className="text-sm truncate">{rec.name}</p>
              <p className="text-xs text-text2 truncate">
                {rec.appName} · {rec.stepCount} {t('settings.cuaEvtSteps')} · {new Date(rec.createdAt || 0).toLocaleString()}
              </p>
            </div>
            <button
              className="px-2 py-1 text-xs bg-btn text-btnFg rounded disabled:opacity-50"
              disabled={!!running}
              onClick={() => startReplay(rec, 'on-request')}
            >
              {t('settings.cuaReplay')}
            </button>
            <button
              className="px-2 py-1 text-xs border border-border rounded disabled:opacity-50"
              disabled={!!running}
              title={t('settings.cuaReplayAlwaysTitle')}
              onClick={() => startReplay(rec, 'always')}
            >
              {t('settings.cuaReplayAlways')}
            </button>
            <button className="px-2 py-1 text-xs border border-border rounded text-error" disabled={!!running} onClick={() => removeRecording(rec.id)}>
              {t('settings.cuaDelete')}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

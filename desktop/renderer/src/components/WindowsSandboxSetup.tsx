// P1-4：Windows OS 级沙箱的接线入口（设置页「沙箱策略」分区内嵌）。
//
// 背景：Windows 沙箱后端（main/sandboxWindows.js）此前「代码在、但无入口」——
// README 自述 OS-level isolation is not yet wired。本组件补上 UI 触达：
//   就绪态 → 可展开的命令清单（审计）→ 一次性管理员设置（UAC 提权）→ 卸载隔离。
//
// 交互取舍：
//   ① 仅在 platform === 'win32' 时渲染，非 Windows 返回 null（宿主侧另有平台守卫）；
//   ② 「执行设置」必须二次确认——它会弹 UAC 并写入系统（建专用用户 / 改 ACL / 加防火墙规则），
//      属高危不可逆动作；与 full-access 切换同强度。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../i18n';
import { confirm } from './feedback';
import Button from './ui/Button';

interface PlanStep { id: string; cmd: string; args: string[]; note?: string }
interface WinPlan { steps: PlanStep[]; rollback: string[] }
// IPC 返回为宽松 Record，读取端显式收窄（同 HooksSection 约定）
interface PlanResult { ok?: boolean; supported?: boolean; platform?: string; plan?: WinPlan }
interface ActionResult {
  ok?: boolean;
  error?: string;
  reason?: string;
  ready?: boolean;
  readyReason?: string;
  storedPath?: string;
  removedStorage?: boolean;
}

export default function WindowsSandboxSetup({ platform, ready, onRefresh }: {
  platform?: string;
  ready?: boolean;
  onRefresh?: () => void;
}) {
  const { t } = useI18n();
  const [plan, setPlan] = useState<WinPlan | null>(null);
  const [showPlan, setShowPlan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const loadPlan = useCallback(async () => {
    try {
      const r = (await api.sandboxWindowsPlan()) as PlanResult | undefined;
      if (r?.ok && r.plan) setPlan(r.plan);
    } catch (e) {
      setErr(String((e as { message?: string })?.message || e));
    }
  }, []);

  useEffect(() => {
    if (platform === 'win32') loadPlan();
  }, [platform, loadPlan]);

  // hooks 全部已调用后再做平台守卫，避免违反 hooks 调用顺序
  if (platform !== 'win32') return null;

  const runSetup = async () => {
    setBusy(true); setMsg(''); setErr('');
    try {
      const go = await confirm({
        title: t('settings.winSandboxSetupConfirmTitle'),
        message: t('settings.winSandboxSetupConfirmMessage'),
        danger: true,
        confirmLabel: t('settings.winSandboxSetupConfirmLabel'),
      });
      if (!go) { setBusy(false); return; }
      const r = (await api.sandboxWindowsSetup()) as ActionResult | undefined;
      if (r?.ok) { setMsg(t('settings.winSandboxSetupDone')); onRefresh?.(); }
      else setErr(t('settings.winSandboxSetupFailed', { reason: r?.reason || r?.error || '' }));
    } catch (e) {
      setErr(String((e as { message?: string })?.message || e));
    } finally { setBusy(false); }
  };

  const runTeardown = async () => {
    setBusy(true); setMsg(''); setErr('');
    try {
      const go = await confirm({
        title: t('settings.winSandboxTeardownConfirmTitle'),
        message: t('settings.winSandboxTeardownConfirmMessage'),
        danger: true,
        confirmLabel: t('settings.winSandboxTeardownConfirmLabel'),
      });
      if (!go) { setBusy(false); return; }
      const r = (await api.sandboxWindowsTeardown()) as ActionResult | undefined;
      if (r?.ok) { setMsg(t('settings.winSandboxTeardownDone')); onRefresh?.(); }
      else setErr(t('settings.winSandboxTeardownFailed', { reason: r?.reason || r?.error || '' }));
    } catch (e) {
      setErr(String((e as { message?: string })?.message || e));
    } finally { setBusy(false); }
  };

  const btn = 'text-xs px-3 py-2 rounded-lg border border-border hover:bg-hover disabled:opacity-40';
  return (
    <div className="border-t border-border py-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{t('settings.winSandboxTitle')}</span>
        <span className="text-xs text-text2">
          {ready ? t('settings.winSandboxReadyLabel') : t('settings.winSandboxNotReadyLabel')}
        </span>
      </div>
      <p className="text-xs text-text2 mt-1 leading-relaxed">{t('settings.winSandboxDesc')}</p>
      <p className="text-xs text-text2 mt-1 leading-relaxed">{t('settings.winSandboxUacNote')}</p>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button onClick={() => setShowPlan((v) => !v)} className={btn}>
          {showPlan ? t('settings.winSandboxHidePlan') : t('settings.winSandboxShowPlan')}
        </button>
        <Button variant="primary" size="sm" onClick={runSetup} disabled={busy}>
          {busy ? t('settings.winSandboxSetupBusy') : t('settings.winSandboxRunSetup')}
        </Button>
        {ready && (
          <button onClick={runTeardown} disabled={busy} className={btn}>
            {t('settings.winSandboxTeardown')}
          </button>
        )}
      </div>
      {showPlan && (
        <div className="mt-3">
          <div className="text-xs font-medium mb-1">{t('settings.winSandboxPlanTitle')}</div>
          {plan && plan.steps.length > 0 ? (
            <pre className="text-xs text-text2 bg-input border border-border rounded-lg p-3 overflow-auto whitespace-pre-wrap break-all">
              {plan.steps.map((s) => `${s.id}: ${s.cmd} ${s.args.join(' ')}`).join('\n')
                + '\n' + t('settings.winSandboxRollbackLabel') + '\n' + plan.rollback.join('\n')}
            </pre>
          ) : (
            <p className="text-xs text-text2">{t('settings.winSandboxPlanEmpty')}</p>
          )}
        </div>
      )}
      {msg && <p className="text-xs text-text2 mt-2 break-all">{msg}</p>}
      {err && <p className="text-xs text-danger mt-2 break-all">{err}</p>}
    </div>
  );
}

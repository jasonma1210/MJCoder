// 版本更新区块（原「账户与更新」页随登录系统移除后，迁入通用页保留更新能力入口）：
// 手动检查 + 状态订阅 + P1-N 手动下载兜底链接（由主进程 build.publish 推导）
import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';

interface UpdaterEvent {
  status: string;
  version?: string;
  percent?: number;
  message?: string;
  downloadUrl?: string;
}

// 与 SettingsModal 内部 Section 同款卡片容器（该组件为文件私有，此处独立复刻避免循环依赖）
const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="mb-8">
    <h2 className="text-base font-semibold mb-3">{title}</h2>
    <div className="bg-surface border border-border rounded-2xl px-5">{children}</div>
  </div>
);

export default function UpdateSection() {
  const { t } = useI18n();
  const [updateStatus, setUpdateStatus] = useState('');
  const [updateError, setUpdateError] = useState('');
  const [updateDownloadUrl, setUpdateDownloadUrl] = useState('');
  const [updaterState, setUpdaterState] = useState(''); // 原始状态机值（驱动「重启安装」按钮显隐）

  useEffect(() => {
    if (!window.mjcode?.onUpdaterStatus) return;
    const off = window.mjcode.onUpdaterStatus((d: UpdaterEvent) => {
      const map: Record<string, string> = {
        checking: t('settings.updaterChecking'),
        available: t('settings.updaterAvailable', { version: d.version || '' }),
        'up-to-date': t('settings.updaterUpToDate'),
        downloading: t('settings.updaterDownloading', { percent: d.percent || 0 }),
        downloaded: t('settings.updaterDownloaded'),
        error: t('settings.updaterError', { message: d.message || t('runtime.unknownError') }),
      };
      setUpdaterState(d.status);
      setUpdateStatus(map[d.status] || d.status);
      setUpdateError('');
      // P1-N：error/available 态携带手动下载链接（自动更新链路失败时的降级出口）
      setUpdateDownloadUrl((d.status === 'error' || d.status === 'available') ? (d.downloadUrl || '') : '');
    });
    return () => { if (typeof off === 'function') off(); };
  }, [t]);

  async function check() {
    setUpdateStatus(t('settings.updaterCheckingNow'));
    setUpdateError('');
    try {
      const r = (await window.mjcode?.checkUpdates?.()) as
        { ok?: boolean; error?: string; downloadUrl?: string } | undefined;
      if (r && !r.ok) {
        setUpdateError(r.error || t('settings.checkFailedLabel'));
        setUpdateDownloadUrl(r.downloadUrl || ''); // P1-N：手动检查失败同样给降级链接
      }
    } catch (err) {
      setUpdateError((err as Error).message);
    }
  }

  async function install() {
    try { await window.mjcode?.installUpdate?.(); } catch (err) { setUpdateError((err as Error).message); }
  }

  return (
    <Section title={t('settings.updateTitle')}>
      <div className="py-4 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">{t('settings.updateCheckTitle')}</div>
          <div className="text-xs text-text2 mt-1">{t('settings.updateNote')}</div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={check} className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-hover">{t('settings.checkUpdate')}</button>
          {updaterState === 'downloaded' && (
            <button onClick={install} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white">{t('settings.restartInstall')}</button>
          )}
        </div>
      </div>
      {(updateStatus || updateError) && (
        <div className="pb-3 text-xs text-text2">
          {updateError || updateStatus}
          {/* P1-N：手动下载兜底——自动更新失败时用户可自行前往 Releases 页下载 */}
          {updateDownloadUrl && (
            <a href={updateDownloadUrl} target="_blank" rel="noreferrer"
              className="ml-2 text-accent underline" title={updateDownloadUrl}>
              {t('settings.manualDownload')}
            </a>
          )}
        </div>
      )}
    </Section>
  );
}

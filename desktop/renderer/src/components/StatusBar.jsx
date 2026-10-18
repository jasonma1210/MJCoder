import { useEffect, useState } from 'react';
import { IconLaptop, IconMessage } from './icons';
import { useI18n } from '../i18n';
import Dot from './ui/Dot';

// 底部状态条（P0-信任闭环）：把「离线 / 本机数据 / 密钥不出本机」从抽象定位变成常驻可见事实
export default function StatusBar({ localMode, threadCount, projectPath, modelName }) {
  const { t } = useI18n();
  const [dataPath, setDataPath] = useState('');
  // X4：本地库状态。初始化失败时任务编排与记忆不可用，必须在界面上看得见
  //（此前只有主进程一行 console.error，用户只会觉得「功能突然没了」）
  const [dbStatus, setDbStatus] = useState(null);

  useEffect(() => {
    const api = window.mjcode;
    if (api && typeof api.dbStatus === 'function') {
      api.dbStatus()
        .then(setDbStatus)
        .catch((err) => console.warn('[status] db status probe failed:', err.message));
    }
    if (!api) return;
    // 本机数据位置：优先取主进程暴露的用户数据目录，取不到则退化为定性文案
    if (typeof api.getUserDataPath === 'function') {
      api.getUserDataPath()
        .then((r) => { if (r && r.ok && r.path) setDataPath(r.path); })
        .catch(() => {});
    }
  }, []);

  return (
    <footer className="h-7 shrink-0 px-4 flex items-center gap-3 text-xs text-text2 border-t border-border bg-sidebar">
      <span className="flex items-center gap-1" title={localMode ? t('statusBar.offlineTitle') : t('statusBar.connectedTitle')}>
        <Dot size="sm" className={localMode ? 'bg-[var(--sem-warn)]' : 'bg-[var(--sem-success)]'} />
        {localMode ? t('statusBar.offlineMode') : t('statusBar.connected')}
      </span>

      {projectPath && (
        /* 与顶栏项目名重复的信息：窄窗口优先让位（顶栏始终可见），避免状态条挤成一行省略号 */
        <span className="hidden xl:flex truncate max-w-[240px] items-center gap-1" title={projectPath}>
          <IconLaptop size={12} /> {projectPath}
        </span>
      )}

      {modelName && <span className="truncate max-w-[160px]">{t('statusBar.model', { name: modelName })}</span>}

      {dbStatus && (dbStatus.ok === false || dbStatus.warning) && (
        <span
          className="flex items-center gap-1 text-warn truncate max-w-[220px]"
          title={dbStatus.ok === false
            ? (dbStatus.reason || t('statusBar.dbUnavailableTitle'))
            : dbStatus.warning}
        >
          <Dot size="sm" className="bg-warn" />
          {dbStatus.ok === false ? t('statusBar.dbUnavailable') : t('statusBar.dbRecovered')}
        </span>
      )}

      <span className="flex items-center gap-1" title={t('statusBar.dataTitle')}>
        <IconMessage size={12} /> {t('statusBar.threadCount', { n: threadCount })}
      </span>

      <span className="ml-auto truncate max-w-[280px]" title={dataPath || t('statusBar.dataPathTitle')}>
        {dataPath ? t('statusBar.dataPath', { path: dataPath }) : t('statusBar.dataLocal')}
      </span>

      <span title={t('statusBar.keyTitle')}>
        {t('statusBar.keyBadge')}
      </span>
    </footer>
  );
}

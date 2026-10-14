import { useEffect, useState } from 'react';
import { IconLaptop, IconMessage } from './icons';

// 底部状态条（P0-信任闭环）：把「离线 / 本机数据 / 密钥不出本机」从抽象定位变成常驻可见事实
export default function StatusBar({ localMode, threadCount, projectPath, modelName }) {
  const [dataPath, setDataPath] = useState('');

  useEffect(() => {
    const api = window.mjcode;
    if (!api) return;
    // 本机数据位置：优先取主进程暴露的用户数据目录，取不到则退化为定性文案
    if (typeof api.getUserDataPath === 'function') {
      api.getUserDataPath()
        .then((r) => { if (r && r.ok && r.path) setDataPath(r.path); })
        .catch(() => {});
    }
  }, []);

  return (
    <footer className="h-7 shrink-0 px-4 flex items-center gap-3 text-[11px] text-text2 border-t border-border bg-sidebar">
      <span className="flex items-center gap-1" title={localMode ? '服务端不可达，线程与消息保存在本机' : '已连接本地服务端'}>
        <span className={`w-1.5 h-1.5 rounded-full ${localMode ? 'bg-[var(--sem-warn)]' : 'bg-[var(--sem-success)]'}`} />
        {localMode ? '离线模式 · 数据仅在本机' : '已连接本地服务端'}
      </span>

      {projectPath && (
        <span className="truncate max-w-[240px] flex items-center gap-1" title={projectPath}>
          <IconLaptop size={12} /> {projectPath}
        </span>
      )}

      {modelName && <span className="truncate max-w-[160px]">模型：{modelName}</span>}

      <span className="flex items-center gap-1" title="会话与消息保存在本机，模型密钥不离开本机">
        <IconMessage size={12} /> {threadCount} 个会话
      </span>

      <span className="ml-auto truncate max-w-[280px]" title={dataPath || '数据保存在本机用户目录'}>
        {dataPath ? `本机数据：${dataPath}` : '数据保存在本机'}
      </span>

      <span title="模型 API Key 仅保存在本机（离线模式经系统密钥链加密），不会上传到任何服务器">
        密钥不出本机
      </span>
    </footer>
  );
}

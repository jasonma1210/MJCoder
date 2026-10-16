import { useEffect, useState } from 'react';
import ThreadList from './ThreadList';
import { IconClock, IconEdit, IconPlus, IconPuzzle, IconSearch, IconSettings, IconArchive } from './icons';
import logo from '../assets/logo.png';
import { useI18n } from '../i18n';

// 左侧栏（对标 Codex）：New chat / Scheduled / Tasks / Plugins + Projects→会话嵌套；底部 Settings
// 「打开项目」不设一级导航：Projects 区头「+」承担添加（Codex 同款），
// 新会话自动归属当前项目/默认工作区，无需先「打开项目」再操作
export default function Sidebar({
  threads, activeThread, onSelect, onNew, onDelete, onRenameThread, onAssignThread, onOpenArchive,
  onOpenScheduled, onOpenEcosystem, onOpenProjectPicker, onOpenSettings,
  projects, activeProject, onSelectProject, onRemoveProject, onRenameProject,
  onNewThread,
  onOpenSearch,
}) {
  const { t } = useI18n();
  // 版本号从主进程 app.getVersion() 动态获取（此前硬编码 v1.0.0，发版后永远显示旧版本）
  const [version, setVersion] = useState('');
  useEffect(() => {
    window.mjcode?.getAppVersion?.().then((v) => { if (v) setVersion(String(v)); }).catch(() => {});
  }, []);
  return (
    <aside className="w-[260px] flex flex-col bg-sidebar border-r border-border">
      {/* 品牌头（Bug4，参考 WorkBuddy）：首行高度留给 macOS 交通灯（右侧仅搜索钮），
          应用名 + 版本独立成行，不再与交通灯挤在同一行 */}
      <div className="shrink-0">
        <div className="flex items-center justify-end px-4 h-11">
          <button onClick={() => onOpenSearch?.()} className="text-text2 hover:text-text" title={t('sidebar.searchTitle')} aria-label={t('sidebar.searchAria')}>
            <IconSearch size={16} />
          </button>
        </div>
        <div className="px-4 pb-3 pt-1">
          <div className="flex items-center gap-2">
            <img src={logo} alt="MJ Code" className="w-6 h-6 rounded-lg shrink-0 object-cover" draggable={false} />
            <div className="font-semibold text-[15px] leading-none">MJ Code</div>
          </div>
          <div className="text-xs text-text2 mt-1">{version ? `v${version} ${t('sidebar.beta')}` : ''} · {t('sidebar.tagline')}</div>
        </div>
      </div>

      {/* 主操作（对标 Codex：New chat / Scheduled / Plugins） */}
      <div className="px-2 space-y-0.5">
        <NavItem icon={<IconEdit size={16} />} label={t('sidebar.newChat')} onClick={onNew} active={!activeThread} />
        <NavItem icon={<IconClock size={16} />} label={t('sidebar.scheduled')} onClick={onOpenScheduled} />
        <NavItem icon={<IconPuzzle size={16} />} label={t('sidebar.ecosystem')} onClick={onOpenEcosystem} />
      </div>

      {/* 会话（项目 → 会话 二级结构） */}
      <div className="flex items-center justify-between mt-4 px-4 mb-1 text-xs text-text2 uppercase tracking-wider">
        <span>{t('sidebar.threadsSection')}</span>
        <button onClick={onOpenProjectPicker} className="text-text2 hover:text-text" title={t('sidebar.addProject')} aria-label={t('sidebar.addProject')}>
          <IconPlus size={13} />
        </button>
      </div>
      <ThreadList
        projects={projects}
        activeProject={activeProject}
        activeThread={activeThread}
        threads={threads}
        onSelectThread={onSelect}
        onSelectProject={onSelectProject}
        onDeleteThread={onDelete}
        onRenameThread={onRenameThread}
        onAssignThread={onAssignThread}
        onNewThread={onNewThread}
        onDeleteProject={onRemoveProject}
        onRenameProject={onRenameProject}
        onOpenProjectPicker={onOpenProjectPicker}
      />

      {/* 底部 */}
      <div className="border-t border-border px-2 py-2 shrink-0">
        {/* P1-E：归档管理仅本地模式可用（服务端归档 API 未实现）——在线模式隐藏入口，
            此前在线模式点击会直接弹「归档管理需离线模式或等待服务端支持」错误 */}
        {onOpenArchive && <NavItem icon={<IconArchive size={16} />} label={t('sidebar.archived')} onClick={onOpenArchive} />}
        <NavItem icon={<IconSettings size={16} />} label={t('sidebar.settings')} onClick={onOpenSettings} />
      </div>
    </aside>
  );
}

function NavItem({ icon, label, onClick, active }) {
  return (
    <button onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm truncate ${active ? 'bg-surface text-text' : 'hover:bg-hover text-text2'}`}>
      <span className="shrink-0">{icon}</span> {label}
    </button>
  );
}
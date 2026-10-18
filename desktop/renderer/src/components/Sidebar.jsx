import { useEffect, useState } from 'react';
import ThreadList from './ThreadList';
import { IconClock, IconEdit, IconPlus, IconPuzzle, IconSettings, IconArchive } from './icons';
import { activeNavOf } from '../lib/navState';
import logo from '../assets/logo.png';
import { useI18n } from '../i18n';

// 左侧栏（对标 Codex）：New chat / Scheduled / Tasks / Plugins + Projects→会话嵌套；底部 Settings
// 「打开项目」不设一级导航：Projects 区头「+」承担添加（Codex 同款），
// 新会话自动归属当前项目/默认工作区，无需先「打开项目」再操作
export default function Sidebar({
  threads, activeThread, onSelect, onNew, onDelete, onRenameThread, onAssignThread, onOpenArchive,
  onOpenScheduled, onOpenEcosystem, onOpenProjectPicker, onOpenSettings,
  projects, activeProject, onSelectProject, onRemoveProject, onRenameProject,
  onNewThread, filter, view,
}) {
  const { t } = useI18n();
  // 一级导航选中态：互斥且穷尽（判定逻辑与其背景见 lib/navState.ts）
  const activeNav = activeNavOf({
    showScheduled: !!view?.showScheduled,
    showDashboard: !!view?.showDashboard,
    showEcosystem: !!view?.showEcosystem,
    hasActiveThread: !!activeThread,
  });
  // 版本号从主进程 app.getVersion() 动态获取（此前硬编码 v1.0.0，发版后永远显示旧版本）
  const [version, setVersion] = useState('');
  useEffect(() => {
    window.mjcode?.getAppVersion?.().then((v) => { if (v) setVersion(String(v)); }).catch(() => {});
  }, []);
  return (
    <aside className="w-[clamp(216px,20vw,260px)] flex flex-col bg-sidebar border-r border-border">
      {/* 品牌头：左栏开关与搜索已上移到统一顶栏（常驻全宽，收起了也还能点），
          此处只留品牌与版本。顶栏已为 macOS 交通灯预留内边距，本行不再需要空出一行。 */}
      <div className="shrink-0 px-4 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <img src={logo} alt="MJ Code" className="w-6 h-6 rounded-lg shrink-0 object-cover" draggable={false} />
          <div className="font-semibold text-base leading-none">MJ Code</div>
        </div>
        <div className="text-xs text-text2 mt-1">{version ? `v${version} ${t('sidebar.beta')}` : ''} · {t('sidebar.tagline')}</div>
      </div>

      {/* 主操作（对标 Codex：New chat / Scheduled / Plugins）
          选中态由 App 计算 activeNav 后传入（互斥）；此前只有 New chat 传 active，
          且判据是 !activeThread —— 在定时任务页里没有打开会话，于是该亮的不亮。 */}
      <div className="px-2 space-y-0.5">
        <NavItem icon={<IconEdit size={16} />} label={t('sidebar.newChat')} onClick={onNew} active={activeNav === 'new'} />
        <NavItem icon={<IconClock size={16} />} label={t('sidebar.scheduled')} onClick={onOpenScheduled} active={activeNav === 'scheduled'} />
        <NavItem icon={<IconPuzzle size={16} />} label={t('sidebar.ecosystem')} onClick={onOpenEcosystem} active={activeNav === 'ecosystem'} />
      </div>

      {/* 会话（项目 → 会话 二级结构） */}
      <div className="flex items-center justify-between mt-4 px-4 mb-1 text-caption text-text2">
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
        filter={filter}
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

// 一级导航项。选中态用 select-bg / select-fg 这对**专用令牌**（theme.css 里本来就为
// 「列表当前选中项」准备了它们，此前零引用）：bg-hover 与 hover 同色，选中和划过长得一样，
// 等于"没选中"。aria-current="page" 同时给出语义与可测锚点。
function NavItem({ icon, label, onClick, active }) {
  return (
    <button onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm truncate ${active ? 'bg-select-bg text-select-fg font-medium' : 'hover:bg-hover text-text2'}`}>
      <span className="shrink-0">{icon}</span> {label}
    </button>
  );
}
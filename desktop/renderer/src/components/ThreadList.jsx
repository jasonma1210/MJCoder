import { useEffect, useRef, useState } from 'react';
import {
  IconChevronDown, IconChevronRight, IconDot, IconEdit, IconFolder, IconFolderOpen,
  IconPlus, IconSpinner, IconTerminal, IconX,
} from './icons';
import ContextMenu from './ContextMenu';
import { toast } from './feedback';
import { projectDisplayName } from '../lib/projectName';

// 会话列表（对标 Codex 侧栏）：按项目分组，线程项带三色状态指示
//   ● 已完成 / ◉ 待审批 / ↻ 运行中
// S1：组内默认渲染 20 条 + 「加载更多」，避免会话量大时整棵渲染卡顿
// S2：组内按时间分段（今天/昨天/本周/更早），不再纯平铺
const GROUP_PAGE_SIZE = 20;
const STATUS_META = {
  running: { label: '运行中', Icon: IconSpinner, dot: 'text-accent' },
  awaiting_approval: { label: '待审批', Icon: IconDot, dot: 'text-success' },
  done: { label: '已完成', Icon: IconDot, dot: 'text-info' },
  idle: { label: '待继续', Icon: IconDot, dot: 'text-text2' },
};

export default function ThreadList({
  projects,
  activeProject,
  activeThread,
  threads,
  onSelectThread,
  onSelectProject,
  onDeleteThread,
  onRenameThread,
  onAssignThread,
  onNewThread,
  onDeleteProject,
  onRenameProject,
  onOpenProjectPicker,
}) {
  const [orphanVisible, setOrphanVisible] = useState(GROUP_PAGE_SIZE);
  // 按项目路径分组：先项目，再该项目的会话
  const groups = projects.map((p) => ({
    project: p,
    items: threads.filter((t) => (t.projectPath || t.cwd) === p.path),
  }));
  const orphans = threads.filter((t) => !projects.some((p) => p.path === (t.projectPath || t.cwd)));

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-2">
      {groups.map(({ project, items }) => (
        <ProjectGroup
          key={project.path}
          project={project}
          items={items}
          collapsed={activeProject?.path !== project.path}
          activeThread={activeThread}
          onSelectThread={onSelectThread}
          onSelectProject={onSelectProject}
          onDeleteThread={onDeleteThread}
          onRenameThread={onRenameThread}
          onNewThread={onNewThread}
          onDeleteProject={onDeleteProject}
          onRenameProject={onRenameProject}
        />
      ))}

      {orphans.length > 0 && (
        <div className="mb-2">
          <SectionLabel label="未归属项目" />
          {orphans.slice(0, orphanVisible).map((t) => (
            <ThreadRow
              key={t.id}
              thread={t}
              active={activeThread?.id === t.id}
              onSelect={onSelectThread}
              onDelete={onDeleteThread}
              onRename={onRenameThread}
              // B1：孤儿会话可归组回任一项目
              assignMenu={projects.length > 0 ? projects : null}
              onAssign={onAssignThread}
            />
          ))}
          {orphans.length > orphanVisible && (
            <button onClick={() => setOrphanVisible((v) => v + GROUP_PAGE_SIZE)}
              className="w-full text-left px-3 py-1.5 text-xs text-text2 hover:text-text">
              加载更多（还有 {orphans.length - orphanVisible} 条）
            </button>
          )}
        </div>
      )}

      {projects.length === 0 && (
        <button onClick={onOpenProjectPicker}
          className="w-full text-left px-3 py-2 rounded-lg text-xs text-text2 hover:bg-hover border border-dashed border-border">
          尚未打开项目，点击选择目录
        </button>
      )}
    </div>
  );
}

function ProjectGroup({
  project, items, collapsed, activeThread, onSelectThread, onSelectProject, onDeleteThread, onRenameThread, onNewThread, onDeleteProject, onRenameProject,
}) {
  const [open, setOpen] = useState(!collapsed);
  const [visible, setVisible] = useState(GROUP_PAGE_SIZE);
  // 切换项目时自动展开对应分组（对标 Codex：选中项目即展开其会话）
  useEffect(() => { setOpen(!collapsed); }, [collapsed]);
  const running = items.filter((t) => t.status === 'running').length;
  const awaiting = items.filter((t) => t.status === 'awaiting_approval').length;

  // 项目右键菜单（对标 WorkBuddy 侧栏）：打开文件夹 / 在 IDE 中打开 / 重命名 / 从列表中移除
  const [menu, setMenu] = useState(null); // { x, y }
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const nameInputRef = useRef(null);
  useEffect(() => { if (editing) nameInputRef.current?.select(); }, [editing]);

  const display = projectDisplayName(project);

  // 打开磁盘目录：目录可能已被用户在 Finder 里删掉，失败必须给出可读原因
  async function openFolder() {
    const r = await window.mjcode?.openPath?.({ path: project.path });
    if (r && r.ok === false) toast({ message: r.error || '打开目录失败' });
  }

  async function openInEditor() {
    const r = await window.mjcode?.openInIDE?.({ path: project.path });
    if (r && r.ok === false) toast({ message: r.error || '打开失败' });
  }

  function commitRename() {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === project.name) return;
    onRenameProject?.(project, next);
  }

  const menuItems = [
    { id: 'open', label: '打开文件夹', icon: IconFolderOpen, onClick: openFolder },
    { id: 'ide', label: '在编辑器中打开', icon: IconTerminal, onClick: openInEditor },
    { separator: true },
    { id: 'rename', label: '重命名', icon: IconEdit, onClick: () => { setDraft(display); setEditing(true); } },
    ...(onDeleteProject ? [{ id: 'remove', label: '从列表中移除', icon: IconX, danger: true, title: '仅从列表移除，不影响磁盘文件', onClick: () => onDeleteProject(project) }] : []),
  ];

  return (
    <div className="mb-1">
      <div className="group flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-hover"
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }); }}>
        <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-text2 shrink-0" title={open ? '折叠' : '展开'}>
          {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </button>
        {editing ? (
          <input
            ref={nameInputRef}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
              if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
            }}
            // 重命名只改显示名，不动磁盘目录（会话归属与沙箱授权都按目录路径）
            title="重命名只修改显示名，磁盘目录不变"
            className="flex-1 min-w-0 bg-surface border border-accent rounded px-1.5 py-0.5 text-xs outline-none"
          />
        ) : (
          <button onClick={() => { onSelectProject(project); setOpen(true); }}
            onDoubleClick={() => { setDraft(display); setEditing(true); }}
            className="flex-1 min-w-0 text-left text-xs truncate flex items-center"
            title={`${project.path || project.name}\n右键查看更多操作`}>
            <span className={activeThread && (project.path === activeThread.projectPath || project.path === activeThread.cwd) ? 'text-text truncate' : 'text-text2 truncate'}>
              {display}
            </span>
          </button>
        )}
        {/* P1-D：「N 待审批」徽标可点击——直达右下角审批卡（展开 + 高亮闪现），
            此前徽标在名字按钮内不可点且无人置位 awaiting_approval，是死代码 */}
        {awaiting > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('mjcode:focus-approval')); }}
            className="text-success text-[10px] shrink-0 px-1 rounded hover:bg-hover"
            title={`${awaiting} 个会话等待审批，点击查看审批卡片`}
            aria-label={`${awaiting} 个会话等待审批`}
          >
            {awaiting} 待审批
          </button>
        )}
        {running > 0 && <span className="text-accent text-[10px] shrink-0">{running} 运行中</span>}
        <button onClick={() => onNewThread(project)} title="在此项目中新建会话"
          className="text-text2 opacity-0 group-hover:opacity-100 px-1" aria-label="在此项目中新建会话">
          <IconPlus size={13} />
        </button>
        {/* 项目删除入口（此前 onRemoveProject 已传入却无任何渲染，导致项目无法删除） */}
        {onDeleteProject && (
          <button onClick={(e) => { e.stopPropagation(); onDeleteProject(project); }}
            className="text-text2 opacity-0 group-hover:opacity-100 hover:text-danger px-1"
            title="移除项目（不影响磁盘文件）" aria-label={`移除项目 ${project.name || project.path}`}>
            <IconX size={13} />
          </button>
        )}
      </div>

      {open && (
        <div className="pl-3">
          {items.length === 0 ? (
            <p className="text-text2 text-xs px-2 py-1">暂无会话</p>
          ) : (
            <>
              {/* S2：先按 S1 截取可见条数，再按时间分段渲染 */}
              {(() => {
                const visibleItems = items.slice(0, visible);
                const buckets = new Map(TIME_BUCKETS.map((b) => [b, []]));
                for (const t of visibleItems) (buckets.get(timeBucket(t)) || buckets.get('更早')).push(t);
                return TIME_BUCKETS.filter((b) => buckets.get(b).length > 0).map((b) => (
                  <div key={b}>
                    <SectionLabel label={b} />
                    {buckets.get(b).map((t) => (
                      <ThreadRow
                        key={t.id}
                        thread={t}
                        active={activeThread?.id === t.id}
                        onSelect={onSelectThread}
                        onDelete={onDeleteThread}
                        onRename={onRenameThread}
                      />
                    ))}
                  </div>
                ));
              })()}
              {items.length > visible && (
                <button onClick={() => setVisible((v) => v + GROUP_PAGE_SIZE)}
                  className="w-full text-left px-2 py-1.5 text-xs text-text2 hover:text-text">
                  加载更多（还有 {items.length - visible} 条）
                </button>
              )}
            </>
          )}
        </div>
      )}

      <ContextMenu
        open={!!menu}
        x={menu?.x || 0}
        y={menu?.y || 0}
        items={menuItems}
        onClose={() => setMenu(null)}
      />
    </div>
  );
}

// A1：双击标题行内重命名（Enter 提交 / Esc 取消，对标 Codex）
function ThreadRow({ thread, active, onSelect, onDelete, onRename, assignMenu, onAssign }) {
  const meta = STATUS_META[thread.status] || STATUS_META.idle;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const assignRef = useRef(null);

  // B3：归组弹层点击外部 / Esc 关闭（此前无任何关闭出口，弹层会一直挂着）
  useEffect(() => {
    if (!assignOpen) return;
    const onDown = (e) => { if (!assignRef.current?.contains(e.target)) setAssignOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setAssignOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [assignOpen]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function startEdit() {
    setDraft(thread.title || '');
    setEditing(true);
  }

  function commit() {
    const clean = draft.trim();
    setEditing(false);
    if (clean && clean !== (thread.title || '')) onRename?.(thread, clean);
  }

  return (
    <div
      className={`px-2 py-1.5 rounded-lg cursor-pointer group flex items-center gap-1.5 ${
        active ? 'bg-surface' : 'hover:bg-hover'
      }`}
      onClick={() => onSelect(thread)}
      onDoubleClick={startEdit}
      title={`${meta.label}｜${thread.model_name || ''}（双击重命名）`}
    >
      <meta.Icon size={11} className={`${meta.dot} shrink-0`} />
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="flex-1 min-w-0 bg-bg border border-accent rounded px-1 py-0.5 text-xs outline-none"
          maxLength={100}
          aria-label="会话标题"
        />
      ) : (
        <span className="text-xs truncate flex-1">{thread.title || '新会话'}</span>
      )}
      {!editing && assignMenu && (
        <div ref={assignRef} className="relative shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); setAssignOpen((v) => !v); }}
            className="text-text2 opacity-0 group-hover:opacity-100"
            title="归组到项目"
            aria-label="归组到项目"
          >
            <IconFolder size={11} />
          </button>
          {assignOpen && (
            <div className="absolute right-0 top-full mt-1 w-40 bg-raise border border-border rounded-lg shadow-[var(--shadow-menu)] z-palette py-1"
              onClick={(e) => e.stopPropagation()}>
              <div className="px-3 py-1 text-[10px] text-text2">归组到…</div>
              {assignMenu.map((p) => (
                <button key={p.path} onClick={() => { setAssignOpen(false); onAssign?.(thread, p.path); }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-hover truncate" title={p.path}>
                  {p.name || p.path}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {!editing && (
        <button
          onClick={(e) => { e.stopPropagation(); startEdit(); }}
          className="text-text2 opacity-0 group-hover:opacity-100 shrink-0"
          title="重命名会话"
          aria-label="重命名会话"
        >
          <IconEdit size={11} />
        </button>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(thread); }}
        className="text-text2 opacity-0 group-hover:opacity-100 shrink-0"
        title="删除会话"
        aria-label="删除会话"
      >
        <IconX size={11} />
      </button>
    </div>
  );
}

function SectionLabel({ label }) {
  return <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-text2">{label}</div>;
}

// S2：会话时间分段（基于 updatedAt/createdAt，缺失时归入「更早」）
function timeBucket(t) {
  const ts = new Date(t.updatedAt || t.updated_at || t.createdAt || t.created_at || 0).getTime();
  if (!ts) return '更早';
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfDay) return '今天';
  if (ts >= startOfDay - 86400000) return '昨天';
  if (ts >= startOfDay - 6 * 86400000) return '本周';
  return '更早';
}

const TIME_BUCKETS = ['今天', '昨天', '本周', '更早'];

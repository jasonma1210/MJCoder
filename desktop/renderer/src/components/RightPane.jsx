import { useEffect, useState } from 'react';
import { IconEye, IconFileDiff, IconFolderOpen, IconX } from './icons';

// 右侧常驻面板（对标 Codex 的 Review Pane / WorkBuddy 的预览栏）：同屏可见，不再用全屏模态打断对话
// 标签：变更（Diff） / 文件（文件树） / 预览（代码 / Markdown / 图片 / PDF / 音视频）
// R5：宽度可拖拽调整（320~900px，持久化 mj_pane_width）
export const PANEL_TABS = [
  { id: 'diff', label: '变更', Icon: IconFileDiff },
  { id: 'files', label: '文件', Icon: IconFolderOpen },
  { id: 'preview', label: '预览', Icon: IconEye },
];

const PANE_MIN = 320;
const PANE_MAX = 900;
const PANE_DEFAULT = 520;

function clampWidth(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(PANE_MAX, Math.max(PANE_MIN, n)) : PANE_DEFAULT;
}

export default function RightPane({
  open,
  tab,
  onTab,
  onClose,
  diffPanel,
  filesPanel,
  previewPanel,
}) {
  const active = PANEL_TABS.find((t) => t.id === tab) || PANEL_TABS[0];
  const [width, setWidth] = useState(() => clampWidth(localStorage.getItem('mj_pane_width') || PANE_DEFAULT));

  // 持久化宽度
  useEffect(() => {
    try { localStorage.setItem('mj_pane_width', String(width)); } catch (e) { /* ignore */ }
  }, [width]);

  // 收起时用 hidden 而非 return null：
  // 常驻面板的语义是「保持上下文」，如果直接卸载，
  // 收起再展开会重新加载 git diff、重建文件树、丢失已查看的文件与滚动位置。
  function startDrag(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    function onMove(ev) {
      setWidth(clampWidth(startW + (startX - ev.clientX)));
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  return (
    <aside
      className={`shrink-0 flex bg-sidebar border-l border-border ${open ? '' : 'hidden'}`}
      style={{ width }}
      aria-hidden={!open}
    >
      {/* R5：左缘拖拽条 */}
      <div onMouseDown={startDrag} className="w-1 shrink-0 cursor-col-resize hover:bg-accent/40" title="拖拽调整面板宽度" />
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center gap-1 px-2 h-12 border-b border-border shrink-0">
          {PANEL_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => onTab(t.id)}
              title={t.label}
              className={`px-3 h-8 rounded-lg text-xs flex items-center gap-1.5 ${
                active.id === t.id ? 'bg-surface text-text' : 'text-text2 hover:text-text'
              }`}
            >
              <t.Icon size={14} />
              {t.label}
            </button>
          ))}
          <button onClick={onClose} className="ml-auto text-text2 hover:text-text p-1" title="收起面板（⌘⌥B）" aria-label="收起面板">
            <IconX size={16} />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex flex-col">
          {active.id === 'diff' && diffPanel}
          {active.id === 'files' && filesPanel}
          {active.id === 'preview' && previewPanel}
        </div>
      </div>
    </aside>
  );
}

// 无项目 / 无选中文件等空态占位，避免面板大片空白
export function PanelEmpty({ icon: Icon, title, hint }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-text2 gap-2 p-8 text-center">
      {Icon && <Icon size={24} />}
      <p className="text-sm">{title}</p>
      {hint && <p className="text-xs">{hint}</p>}
    </div>
  );
}

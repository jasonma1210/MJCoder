import FilePreview from './FilePreview';
import { IconFile, IconX } from './icons';

// 右侧「预览」标签：多文件标签页 + 应用内预览（对标 WorkBuddy 右侧文件预览栏）
//
// 为什么要有标签条：Agent 一轮任务往往改/读多个文件，若只有单一「当前文件」，
// 每次切换都丢失上一个文件的滚动位置与查看上下文，用户只能来回点文件树。
// 标签条保留最近打开的若干文件，点 × 关掉单个（关闭当前标签后自动激活相邻标签）。
const MAX_LABELS = 12;

function baseName(p) {
  return String(p || '').split('/').pop() || String(p || '');
}

export default function FileViewerPane({ files = [], active, projectPath, onSelect, onClose }) {
  if (!files.length) return null;
  const shown = files.slice(-MAX_LABELS);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-stretch gap-0.5 px-1.5 pt-1.5 pb-0 border-b border-border shrink-0 overflow-x-auto">
        {shown.map((f) => {
          const isActive = f === active;
          return (
            <div
              key={f}
              className={`group flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-t-lg text-[11px] max-w-[180px] shrink-0 ${
                isActive ? 'bg-bg text-text border border-border border-b-transparent -mb-px' : 'text-text2 hover:bg-hover'
              }`}
            >
              <button
                onClick={() => onSelect?.(f)}
                title={f}
                className="truncate flex items-center gap-1.5 min-w-0"
              >
                <IconFile size={11} className="shrink-0" />
                <span className="truncate font-mono">{baseName(f)}</span>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onClose?.(f); }}
                title="关闭该标签"
                aria-label={`关闭 ${baseName(f)}`}
                className="shrink-0 text-text2 hover:text-text rounded p-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              >
                <IconX size={10} />
              </button>
            </div>
          );
        })}
      </div>

      {active
        ? <FilePreview filePath={active} projectPath={projectPath} />
        : <div className="flex-1 flex items-center justify-center text-xs text-text2">请选择一个文件</div>}
    </div>
  );
}

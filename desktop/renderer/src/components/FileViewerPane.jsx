import FilePreview from './FilePreview';
import { IconFile, IconPlus, IconX } from './icons';
import { useI18n } from '../i18n';

// 右侧「预览」标签：多文件标签页 + 应用内预览（对标 WorkBuddy 右侧文件预览栏）
//
// 为什么要有标签条：Agent 一轮任务往往改/读多个文件，若只有单一「当前文件」，
// 每次切换都丢失上一个文件的滚动位置与查看上下文，用户只能来回点文件树。
// 标签条保留最近打开的若干文件，点 × 关掉单个（关闭当前标签后自动激活相邻标签）。
const MAX_LABELS = 12;

function baseName(p) {
  return String(p || '').split('/').pop() || String(p || '');
}

/**
 * 预览容器：多文件标签 + 当前文件正文。
 * JSDoc 类型注解是必需的（不是装饰）：`files = []` 的默认值会让 TS 把该 prop 推断为 never[]，
 * 于是 .tsx 调用方（FilesPanel）传入 string[] 会报 TS2322。注解后跨文件类型即正确。
 * @param {{
 *   files?: string[],
 *   active?: string | null,
 *   projectPath?: string,
 *   onSelect?: (path: string) => void,
 *   onClose?: (path: string) => void,
 * }} props
 */
export default function FileViewerPane({ files = [], active, projectPath, onSelect, onClose }) {
  const { t } = useI18n();
  if (!files.length) return null;
  const shown = files.slice(-MAX_LABELS);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-stretch gap-1 px-2 pt-2 pb-0 border-b border-border shrink-0 overflow-x-auto">
        {shown.map((f) => {
          const isActive = f === active;
          return (
            <div
              key={f}
              className={`group flex items-center gap-1 pl-3 pr-1 py-1 rounded-t-lg text-xs max-w-[180px] shrink-0 ${
                isActive ? 'bg-bg text-text border border-border border-b-transparent -mb-px' : 'text-text2 hover:bg-hover'
              }`}
            >
              <button
                onClick={() => onSelect?.(f)}
                title={f}
                className="truncate flex items-center gap-2 min-w-0"
              >
                <IconFile size={11} className="shrink-0" />
                <span className="truncate font-mono">{baseName(f)}</span>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onClose?.(f); }}
                title={t('filePreview.closeTabTitle')}
                aria-label={t('filePreview.closeTab', { name: baseName(f) })}
                className="shrink-0 text-text2 hover:text-text rounded p-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              >
                <IconX size={10} />
              </button>
            </div>
          );
        })}
        {/* F4：把当前预览文件添加到对话框（mjcode:add-attachment 事件总线 → 输入框附件 chip） */}
        {active && (
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('mjcode:add-attachment', { detail: { path: active } }))}
            title={t('message.addToChat')}
            aria-label={t('message.addToChat')}
            className="ml-auto shrink-0 self-center flex items-center gap-1 px-2 h-6 rounded-lg text-caption text-text2 hover:text-text hover:bg-hover"
          >
            <IconPlus size={11} />
            <span className="whitespace-nowrap">{t('message.addToChat')}</span>
          </button>
        )}
      </div>

      {active
        ? <FilePreview filePath={active} projectPath={projectPath} />
        : <div className="flex-1 flex items-center justify-center text-xs text-text2">{t('filePreview.selectFile')}</div>}
    </div>
  );
}

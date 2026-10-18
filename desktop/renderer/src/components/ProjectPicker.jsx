import CreateProjectForm from './CreateProjectForm';
import Modal from './ui/Modal';
import { IconFolder, IconX } from './icons';
import { useI18n } from '../i18n';

// 创建项目弹窗：默认在 ~/Documents/.MJCoder 下新建（日期+随机数），或添加已有本地文件夹
// O6：顶部补最近项目列表 —— 名为 Picker 实为 Creator 的问题修正，切换项目不必绕道侧栏
export default function ProjectPicker({ open, onClose, onSelect, projects = [], onSelectProject }) {
  const { t } = useI18n();
  if (!open) return null;

  // P1-9：外壳交给 ui/Modal（role=dialog + 焦点陷阱 + Esc + 关闭归还焦点），
  // frameless 只换外壳：遮罩类名沿用原字符串（顶部 96px 落位 + 可滚动），面板样式原样保留。
  return (
    <Modal
      open
      onClose={onClose}
      frameless
      ariaLabel={t('project.title')}
      overlayClassName="fixed inset-0 bg-overlay flex items-start justify-center pt-24 z-settings overflow-y-auto"
    >
      <div className="bg-surface border border-border rounded-2xl w-[min(620px,calc(100vw-2rem))] p-6 shadow-[var(--shadow-pop)] my-8">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-semibold">{t('project.title')}</h3>
          <button onClick={onClose} aria-label={t('project.close')} className="text-text2 hover:text-text">
            <IconX size={20} />
          </button>
        </div>

        {projects.length > 0 && (
          <div className="mb-6">
            <div className="text-xs text-text2 mb-2">{t('project.recent')}</div>
            <div className="space-y-1">
              {projects.slice(0, 5).map((p) => (
                <button key={p.path} onClick={() => onSelectProject?.(p)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border border-border hover:bg-hover text-left">
                  <IconFolder size={16} className="text-text2 shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm truncate">{p.name || p.path}</span>
                    <span className="block text-xs text-text2 truncate font-mono">{p.path}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="text-xs text-text2 mb-2">{t('project.newSection')}</div>
        <CreateProjectForm
          onCreated={(p) => { onSelect?.(p); onClose?.(); }}
          onCancel={onClose}
        />
      </div>
    </Modal>
  );
}
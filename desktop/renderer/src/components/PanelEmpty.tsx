import type { ComponentType } from 'react';
import { IconFile, IconFolderOpen } from './icons';

// 无项目 / 无选中文件等空态占位，避免面板大片空白。
// 从 RightPane.jsx 抽出：新增面板（文件/终端/任务摘要）都要用它，
// 留在 RightPane 内部会与 FilesPanel 形成循环 import。
//
// 门禁适配：渲染层新文件必须是 .ts/.tsx（no-new-jsx 基线只减不增），故本文件带类型。

type IconComponent = ComponentType<{ size?: number; className?: string }>;

interface PanelEmptyProps {
  icon?: IconComponent;
  title?: string;
  hint?: string;
}

export default function PanelEmpty({ icon: Icon, title, hint }: PanelEmptyProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 p-8 text-center">
      {Icon && <Icon size={24} className="text-text2" />}
      <p className="text-sm text-text">{title}</p>
      {hint && <p className="text-xs text-text2 max-w-[46ch] leading-relaxed">{hint}</p>}
    </div>
  );
}

// 「未选项目」的通用空态：右栏各面板在无项目时共用同一措辞
export function NoProjectEmpty({ title, hint }: { title?: string; hint?: string }) {
  return <PanelEmpty icon={IconFolderOpen} title={title} hint={hint} />;
}

// 「未打开文件」的通用空态
export function NoFileEmpty({ title, hint }: { title?: string; hint?: string }) {
  return <PanelEmpty icon={IconFile} title={title} hint={hint} />;
}

// UI 原语：状态圆点（P1-7）
//
// 收敛仓库里手写的魔法尺寸圆点（`w-1.5 h-1.5 rounded-full` / `w-1 h-1 rounded-full`）。
// 尺寸只两档，色调**不预设**——由调用方通过 className 传入（如 bg-danger / bg-text2），
// 组件内零十六进制、零 Tailwind 裸调色板色。渲染为装饰性 span（aria-hidden），
// 语义一律交给相邻文案承载。
export type DotSize = 'xs' | 'sm';

const SIZE_CLASS: Record<DotSize, string> = {
  xs: 'w-1 h-1',
  sm: 'w-1.5 h-1.5',
};

export interface DotProps {
  /** xs = w-1 h-1，sm = w-1.5 h-1.5（默认） */
  size?: DotSize;
  /** 色调与上下文类名（如 bg-danger） */
  className?: string;
}

export default function Dot({ size = 'sm', className = '' }: DotProps) {
  return (
    <span
      aria-hidden="true"
      className={['rounded-full shrink-0', SIZE_CLASS[size], className].filter(Boolean).join(' ')}
    />
  );
}

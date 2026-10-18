// UI 原语：按钮（P1-9）
//
// 目标不是「做一个设计系统」（那是 P2-5 的事），而是给新增界面的实心主按钮/次按钮
// 一个统一出口，避免又一次把 `bg-accent-solid text-on-accent hover:brightness-110`
// 手写第七遍。只覆盖仓库里确实存在的四种形态，参数保持最小。
//
// 配色全部走 theme.css 的语义 token（accent-solid / on-accent / border / hover / danger-solid），
// 组件内零十六进制、零 Tailwind 调色板裸色；尺寸只两档（h-8 与 h-9），不发明第三档。
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-accent-solid text-on-accent hover:brightness-110 border border-transparent',
  secondary: 'border border-border text-text2 hover:bg-hover hover:text-text bg-transparent',
  ghost: 'text-text2 hover:text-text bg-transparent border border-transparent',
  danger: 'bg-danger-solid text-on-accent hover:brightness-110 border border-transparent',
};

// sm = 列表行内小按钮（h-7），md = 表单主操作（h-8）——与仓库既有取值对齐
const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-7 px-3 text-xs',
  md: 'h-8 px-4 text-xs',
};

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 进行中：禁用点击 + aria-busy，文案不变（避免按钮宽度跳动） */
  loading?: boolean;
  children?: ReactNode;
}

export default function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  type = 'button',
  className = '',
  onClick,
  children,
  ...rest
}: ButtonProps) {
  const blocked = disabled || loading;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={blocked}
      aria-busy={loading || undefined}
      className={[
        'inline-flex items-center justify-center gap-2 rounded-lg whitespace-nowrap',
        'transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        SIZE_CLASS[size],
        VARIANT_CLASS[variant],
        className,
      ].filter(Boolean).join(' ')}
      {...rest}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin"
        />
      )}
      {children}
    </button>
  );
}

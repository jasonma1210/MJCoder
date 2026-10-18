// UI 原语：进度条（P1-7）
//
// 收敛重复的 track + fill 结构（`rounded-full bg-border overflow-hidden` 轨道 +
// `h-full` 填充）。与 Dot 同理：尺寸/过渡/色调**不预设**，由调用方通过 className /
// fillClassName 传入，保证与既有实现像素级一致。
import type { HTMLAttributes } from 'react';

export interface BarProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** 填充百分比（0-100） */
  value: number;
  /** 轨道附加类名，如 `h-1.5` / `w-24 h-1` */
  className?: string;
  /** 填充附加类名，如 `bg-accent transition-all` */
  fillClassName?: string;
}

export default function Bar({ value, className = '', fillClassName = '', ...rest }: BarProps) {
  return (
    <div
      className={['rounded-full bg-border overflow-hidden', className].filter(Boolean).join(' ')}
      {...rest}
    >
      <div
        className={['h-full', fillClassName].filter(Boolean).join(' ')}
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

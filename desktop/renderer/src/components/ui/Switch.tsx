// UI 原语：开关（P1-9）
//
// 背景：改造前全仓有 7 处**逐字重复**的手写开关（EcosystemModal ×2、LocalMcpSection、
// SettingsModal、LocalSkillsSection ×2、ScheduledTasks），滑块位移写死 22px 的任意值类
// 魔法数字——轨道宽一改（或加边框）就错位，且 `bg-white` 在浅色主题下与轨道几乎同色。
//
// 本组件做三件事，且**只做这三件事**（布局收敛属 P2-5，不在本轮）：
//   ① 语义：W3C WAI-ARIA Switch Pattern —— `role="switch"` + `aria-checked` + 可访问名称
//      + Space/Enter 切换（`<button>` 原生会因这两个键触发 click，故显式 preventDefault
//      后自行切换，避免「一次按键切两次」）。
//   ② 几何：轨道/滑块/位移全部走 CSS 变量（`--switch-*`），不再出现滑块绝对位移魔法数字。
//   ③ 配色：滑块填充/描边走 `--sem-knob` / `--sem-knob-ring` token（暗色=原视觉，
//      浅色加深描边保证可辨），组件内零十六进制、零 Tailwind 调色板裸色。
//
// 视觉不变量（从改造前的 className 逐项提取，禁止「顺手美化」）：
//   轨道 w-11(44px) / h-6(24px) / rounded-full / 关闭态 bg-hover + border border-border / 开启态 bg-accent
//   滑块 w-5(20px) / h-5(20px) / rounded-full / top-0.5(2px) / 关闭 left-0.5(2px) / 开启 left 22px
//   ⇒ 位移由 `calc(轨道宽 - 滑块宽 - 2×内边距)` 推出，不再写死像素（原 22px 就是这个式子的反推值）。
//   注：审计文档给的是 40/18 一组数字，那是按 40px 轨道假设的；实际 className 是 w-11(44px)，
//   而「保留原有视觉」是硬要求，故轨道维持 44px，位移由 calc 自洽导出（改轨道宽不会错位）。
import type { CSSProperties, KeyboardEvent } from 'react';

export interface SwitchProps {
  /** 当前开关状态 */
  checked: boolean;
  /** 切换回调：收到的是「目标态」，调用方不必自己取反 */
  onChange: (next: boolean) => void;
  /** 可访问名称（必填：开关没有可见文字，缺了它屏幕阅读器只会念「开关」） */
  label: string;
  disabled?: boolean;
  /** 外层附加类（宽度/间距之类由调用方决定，本组件不改布局） */
  className?: string;
}

// 几何量集中在组件内：改轨道宽/滑块尺寸只改一处，位移自动跟随
const SWITCH_GEOMETRY = {
  '--switch-w': '44px',
  '--switch-h': '24px',
  '--switch-knob': '20px',
  '--switch-inset': '2px',
  '--switch-travel': 'calc(var(--switch-w) - var(--switch-knob) - 2 * var(--switch-inset))',
} as CSSProperties;

export default function Switch({ checked, onChange, label, disabled = false, className = '' }: SwitchProps) {
  // 原生 button 在 Space/Enter 上会自行触发 click；这里接管键盘并 preventDefault，
  // 保证「按一次键 = 切一次」，同时 Space 不再滚动页面。
  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (e.key !== ' ' && e.key !== 'Enter' && e.key !== 'Spacebar') return;
    e.preventDefault();
    onChange(!checked);
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => { if (!disabled) onChange(!checked); }}
      onKeyDown={handleKeyDown}
      style={SWITCH_GEOMETRY}
      className={[
        'w-[var(--switch-w)] h-[var(--switch-h)] rounded-full transition-colors relative shrink-0',
        checked ? 'bg-accent' : 'bg-hover border border-border',
        disabled ? 'opacity-50 cursor-not-allowed' : '',
        className,
      ].filter(Boolean).join(' ')}
    >
      <span
        aria-hidden="true"
        className="absolute w-[var(--switch-knob)] h-[var(--switch-knob)] rounded-full bg-[var(--sem-knob)] border border-[color:var(--sem-knob-ring)] top-[var(--switch-inset)] transition-all"
        style={{ left: checked ? 'var(--switch-travel)' : 'var(--switch-inset)' }}
      />
    </button>
  );
}

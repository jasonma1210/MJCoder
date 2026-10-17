/** @type {import('tailwindcss').Config} */

// 颜色 token 统一走 `rgb(var(--x-rgb) / <alpha-value>)`：
// Tailwind v3 对 `var(--hex)` 无法应用 `/opacity`，此前 `border-accent/40`、
// `bg-accent/10` 这类类会整个不生成（带 border 的元素回退到 preflight 的 #e5e7eb），
// 是「暗色界面上莫名出现亮白细边」的根因。三元组形式可正常生成透明度变体。
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: v('theme-bg-rgb'),
        sidebar: v('theme-sidebar-rgb'),
        surface: v('theme-surface-rgb'),
        border: v('theme-border-rgb'),
        'border-strong': v('border-strong-rgb'),
        text: v('theme-text-rgb'),
        text2: v('theme-text2-rgb'),
        'text-disabled': v('theme-text-disabled-rgb'),
        accent: v('theme-accent-rgb'),
        // 实心按钮底 / 其上的字：与 accent（文字色）拆开——两者对对比度的要求相反，
        // 同一个绿色不可能既当「暗底上的亮文字」又当「承载白字的深色块」。
        'accent-solid': v('theme-accent-solid-rgb'),
        'on-accent': v('theme-on-accent-rgb'),
        'accent-soft': v('theme-accent-soft-rgb'),
        // 选中态专用：列表/下拉里「当前选中项」的底色与前景色。
        // 与 accent-soft 分开是因为后者是饱和色（图标/次要强调），用作行底色会压住正文对比度。
        'select-bg': 'var(--theme-select-bg)',
        'select-fg': v('theme-select-fg-rgb'),
        hover: v('theme-hover-rgb'),
        success: v('sem-success-rgb'),
        danger: v('sem-danger-rgb'),
        'danger-solid': v('sem-danger-solid-rgb'),
        warn: v('sem-warn-rgb'),
        info: v('sem-info-rgb'),
        overlay: 'var(--sem-overlay)',
        // 淡底 token：Tailwind v3 不支持 CSS 变量色 /opacity，组件须用这些而非 red-500/10
        'success-bg': 'var(--sem-success-bg)',
        'danger-bg': 'var(--sem-danger-bg)',
        'warn-bg': 'var(--sem-warn-bg)',
        'info-bg': 'var(--sem-info-bg)',
        'accent-bg': 'var(--sem-accent-bg)',
        raise: v('surface-raise-rgb'),
        // 表单凹陷面：比卡片暗一档，替代此前直接复用页面底色 bg-bg（凹陷过深）
        input: v('surface-input-rgb'),
      },
      // 字阶：补齐 13px 中间档（中文在 12px 以下笔画会粘连）；prose 单列一档给对话正文
      fontSize: {
        caption: ['11px', { lineHeight: '16px' }],
        // 等宽内容（终端 / 工具输出 / 代码预览）：12px 与行高 18px 严格成对，
        // VirtualText 的 LINE_H=18 依赖这个组合，改一处必须同步另一处
        code: ['12px', { lineHeight: '18px' }],
        xs: ['13px', { lineHeight: '20px' }],
        sm: ['14px', { lineHeight: '21px' }],
      },
      // 圆角：引用 theme.css 的 --radius-* 变量（此前 token 定义了但组件零引用）
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
        '3xl': 'var(--radius-3xl)',
      },
      zIndex: {
        drawer: 'var(--z-drawer)',
        settings: 'var(--z-settings)',
        menu: 'var(--z-menu)',
        diff: 'var(--z-diff)',
        approval: 'var(--z-approval)',
        palette: 'var(--z-palette)',
        toast: 'var(--z-toast)',
        splash: 'var(--z-splash)',
      },
    },
  },
  plugins: [],
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--theme-bg)',
        sidebar: 'var(--theme-sidebar)',
        surface: 'var(--theme-surface)',
        border: 'var(--theme-border)',
        text: 'var(--theme-text)',
        text2: 'var(--theme-text-secondary)',
        accent: 'var(--theme-accent)',
        'accent-soft': 'var(--theme-accent-soft)',
        hover: 'var(--theme-hover)',
        success: 'var(--sem-success)',
        danger: 'var(--sem-danger)',
        warn: 'var(--sem-warn)',
        info: 'var(--sem-info)',
        overlay: 'var(--sem-overlay)',
        // 淡底 token：Tailwind v3 不支持 CSS 变量色 /opacity，组件须用这些而非 red-500/10
        'success-bg': 'var(--sem-success-bg)',
        'danger-bg': 'var(--sem-danger-bg)',
        'warn-bg': 'var(--sem-warn-bg)',
        'info-bg': 'var(--sem-info-bg)',
        'accent-bg': 'var(--sem-accent-bg)',
        raise: 'var(--surface-raise)',
        'border-strong': 'var(--border-strong)',
      },
      zIndex: {
        drawer: 'var(--z-drawer)',
        settings: 'var(--z-settings)',
        menu: 'var(--z-menu)',
        diff: 'var(--z-diff)',
        approval: 'var(--z-approval)',
        palette: 'var(--z-palette)',
        toast: 'var(--z-toast)',
      },
    },
  },
  plugins: [],
};

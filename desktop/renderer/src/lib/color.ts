// 强调色运行时落盘（TH5 + 2026-10-17 视觉修复）
//
// 背景：主题色由 CSS 变量承载，其中每个颜色有 **两份** 表示：
//   `--theme-accent`     hex，给 CSS / SVG / getComputedStyle 用；
//   `--theme-accent-rgb` "r g b"，给 Tailwind 的 `bg-accent/10` 这类透明度类用。
// 用户自定义强调色只写 hex 的话，所有 `/opacity` 类会重新失效（Tailwind v3
// 无法对 var() 应用 alpha），表现为描边/淡底突然变白或消失。
// 因此强调色的读写在渲染层只允许走本模块，禁止各处自行 setProperty。

const KEYS = {
  hex: ['--theme-accent', '--sem-accent'],
  rgb: ['--theme-accent-rgb', '--sem-accent-rgb'],
} as const;

/** `#rgb` / `#rrggbb` → `"r g b"`；非法输入返回 null（调用方按「不覆盖」处理） */
export function hexToRgbTriplet(hex: string): string | null {
  const raw = String(hex || '').trim().replace(/^#/, '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

/**
 * 应用自定义强调色；传 null / 空串表示回落到主题自带强调色。
 * 同时写入 hex 与 rgb 两份变量，保证 Tailwind 的透明度类继续生效。
 */
export function applyAccent(color: string | null | undefined, root: HTMLElement = document.documentElement): void {
  const hex = String(color || '').trim();
  if (!hex) {
    for (const k of [...KEYS.hex, ...KEYS.rgb]) root.style.removeProperty(k);
    return;
  }
  const triplet = hexToRgbTriplet(hex);
  if (!triplet) return; // 非法色值不落地，避免出现半套变量
  for (const k of KEYS.hex) root.style.setProperty(k, hex);
  for (const k of KEYS.rgb) root.style.setProperty(k, triplet);
}

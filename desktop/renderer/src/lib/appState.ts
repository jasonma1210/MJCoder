import { tGlobal } from '../i18n';
import { applyAccent } from './color';

/**
 * App 层用到的纯工具：默认项目对象、localStorage JSON 读取、主题落地。
 * 从 App.jsx 抽出（God File 800 行门禁），行为不变：
 * · 语言文案不冻结 —— getDefaultProject 是工厂函数，调用时才求值。
 * · 缺 key / 坏 JSON 一律回落 fallback，并留一条可查的 warn。
 */
export function getDefaultProject() {
  return { id: 'default', name: tGlobal('app.defaultProject'), path: '' };
}

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return (JSON.parse(raw) as T) ?? fallback;
  } catch (e) {
    console.warn('[app] failed to parse local data:', key);
    return fallback;
  }
}

/**
 * 主题落地：写 data-theme / data-platform、应用自定义强调色、记住选择。
 * 平台标记用于顶栏按 macOS 交通灯计算留白（--titlebar-inset）。
 */
export function applyThemeToDocument(theme: string): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent || '');
  root.setAttribute('data-platform', isMac ? 'darwin' : 'other');
  // 强调色必须成对写入 hex + rgb（见 lib/color.ts），否则 /opacity 类会失效
  let accent: string | null = null;
  try {
    accent = localStorage.getItem('mj_accent');
  } catch {
    accent = null;
  }
  applyAccent(accent);
  try {
    localStorage.setItem('mj_theme', theme);
  } catch {
    /* 隐私模式等写不进去：不影响本次渲染 */
  }
}

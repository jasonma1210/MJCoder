// 链接打开策略：设置页「浏览器与链接」的可选档位必须真正改变行为
//
// 为什么单独立一个模块：设置项若只在设置页里存个值、没有任何代码读它，
// 就是「假开关」——用户在设置里点半天，回到正文里行为毫无区别。
// 所有链接点击统一走 openLinkByMode()，档位语义集中在这里一处定义。
const KEY = 'mj_link_open_mode';

/** smart（默认）| system | copy */
export function getLinkOpenMode() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'system' || v === 'copy' ? v : 'smart';
  } catch (e) {
    console.warn('[linkOpen] 读取链接打开方式失败:', e);
    return 'smart';
  }
}

export function setLinkOpenMode(mode) {
  try {
    localStorage.setItem(KEY, mode === 'system' || mode === 'copy' ? mode : 'smart');
    return true;
  } catch (e) {
    console.warn('[linkOpen] 保存链接打开方式失败:', e);
    return false;
  }
}

export function isHttpUrl(href) {
  return /^https?:\/\//i.test(String(href || ''));
}

/**
 * 按当前档位处理一次链接点击。
 * 返回：
 *   'external'   已交给系统浏览器
 *   'copied'     已复制到剪贴板
 *   'passthrough' 非 http(s)（本地文件/相对路径/锚点）→ 交给调用方决定，
 *                 例如预览栏用系统默认应用打开该文件
 */
export async function openLinkByMode(href) {
  const url = String(href || '');
  if (!url) return 'passthrough';
  const mode = getLinkOpenMode();

  if (mode === 'copy') {
    try {
      await navigator.clipboard?.writeText?.(url);
      return 'copied';
    } catch (e) {
      console.warn('[linkOpen] 复制链接失败:', e);
      return 'passthrough';
    }
  }

  if (!isHttpUrl(url)) return 'passthrough';

  const r = await window.mjcode?.openExternal?.({ url });
  return r && r.ok === false ? 'passthrough' : 'external';
}

// 导航守卫（2026-10-17 真机 bug 的回归门禁）
//
// 事故形态（用户实测）：在对话界面点「+」里的某些 MCP（尤其是需要授权/跳转的），
// 回到窗口时不是原会话，而是**新建会话界面**。
//
// 根因链：
//   ① 渲染层 markdown 链接原样输出 `<a href>`，没有 target、没有拦默认行为；
//   ② 主进程只注册了 setWindowOpenHandler（只拦 target=_blank / window.open），
//      **没有 will-navigate**（拦不住同窗口导航）。
//   ⇒ 点链接 → Electron 在应用窗口内整页导航 → SPA 被卸载 → 返回时重新加载
//      → activeThread 回到初始 null → 用户看到"新建会话"。
//
// 这里守两件事：渲染层外链必须走系统浏览器；主进程必须有同窗口导航兜底。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`[PASS] ${name}`);
    pass++;
  } catch (e) {
    console.error(`[FAIL] ${name} — ${e.message}`);
    process.exitCode = 1;
  }
}
const ok = (v, m) => { if (!v) throw new Error(m || '断言为假'); };

// ── 主进程：同窗口导航兜底 ──
const win = read('main/lifecycle/window.js');

check('主窗口注册了 will-navigate', () => {
  ok(/webContents\.on\(\s*'will-navigate'/.test(win), '缺少 will-navigate —— 同窗口导航会让 SPA 整页重载、会话丢失');
});

check('will-navigate 里先 preventDefault，再交给系统浏览器', () => {
  const seg = win.slice(win.indexOf("'will-navigate'"));
  ok(/event\.preventDefault\(\)/.test(seg), '未取消默认导航');
  ok(/shell\.openExternal\(url\)/.test(seg), '取消后没有交给系统浏览器（用户会觉得点了没反应）');
});

check('内部地址放行（否则开发态自己都进不去）', () => {
  ok(/isInternalUrl/.test(win), '缺少内部地址判定');
  ok(/protocol === 'file:'/.test(win), '打包态未放行 file://');
  ok(/localhost/.test(win) || /127\.0\.0\.1/.test(win), '开发态未放行本地 dev server');
});

check('既有 setWindowOpenHandler 仍在（target=_blank 两条路径都要守）', () => {
  ok(/setWindowOpenHandler/.test(win), 'setWindowOpenHandler 被删了');
});

// ── 渲染层：markdown 外链必须走 openExternal ──
const ms = read('renderer/src/components/MessageStream.tsx');

check('markdown 的 a 组件对外链做了 preventDefault + openExternal', () => {
  const i = ms.indexOf('a: ({ href');
  ok(i > 0, '找不到 a 组件覆盖');
  const seg = ms.slice(i, i + 1600);
  ok(/preventDefault\(\)/.test(seg), '外链没有拦默认行为 —— 会整页导航');
  ok(/openExternal/.test(seg), '外链没有交给系统浏览器');
  ok(/target="_blank"/.test(seg), '缺少 target 兜底');
  ok(/rel="noreferrer"/.test(seg), '缺少 rel=noreferrer');
});

check('本地文件路径仍走 onOpenFile，不被外链分支吃掉', () => {
  const i = ms.indexOf('a: ({ href');
  const seg = ms.slice(i, i + 1600);
  ok(/onOpenFile/.test(seg), '本地文件点击路径丢失');
  ok(/isFilePathLike/.test(seg), '本地文件判定丢失');
});

// ── 全仓：不允许出现裸的 http 外链 <a>（无 target 且无拦默认） ──
check('渲染层没有裸 http 外链（会整页导航的写法）', () => {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(jsx|tsx)$/.test(e.name)) files.push(p);
    }
  };
  walk('renderer/src');
  const bad = [];
  for (const f of files) {
    const body = read(f);
    // 该文件是否已建立"外链守卫"机制（同时出现 preventDefault 与 openExternal）
    const fileGuarded = /preventDefault\(\)/.test(body) && /openExternal/.test(body);
    for (const m of body.matchAll(/<a\s[^>]{0,300}?>/g)) {
      const tag = m[0];
      if (!/href=/.test(tag)) continue;
      const hasTarget = /target=/.test(tag);
      const after = body.slice(m.index, m.index + tag.length + 200);
      const hasGuardHere = /preventDefault/.test(after);
      // 字面量 http 链接：必须自带 target 或拦默认
      if (/href=["'`]https?:/.test(tag)) {
        if (!hasTarget && !hasGuardHere) bad.push(`${f}: ${tag.slice(0, 60)}`);
        continue;
      }
      // href 是变量：无法静态判定具体值。只有在文件完全没有守卫机制时才报
      // （MessageStream 的 `<a href={href}>` 是锚点/相对路径的兜底分支，文件已有统一守卫，属合理保留）
      if (/href=\{/.test(tag) && !fileGuarded && !hasTarget && !hasGuardHere) {
        bad.push(`${f}: ${tag.slice(0, 60)}`);
      }
    }
  }
  ok(bad.length === 0, `以下 <a> 点击会整页导航：\n  ${bad.slice(0, 5).join('\n  ')}`);
});

console.log(`\n结果：${pass}/${total} 通过`);

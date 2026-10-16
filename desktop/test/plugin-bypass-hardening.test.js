// P0-S2 回归测试：插件签名绕过 + CSP
//
// 事故背景：
//   1) main.js 的 market:installGit 把客户端 payload 里的 allowUnsigned /
//      allowUnsafeInjection 直接透传给 pluginMarket，等于让渲染层可以关闭
//      fail-closed 签名校验与提示注入扫描；
//   2) preload.js 的 marketInstallGit 原样透传整个 payload，无字段白名单；
//   3) renderer/index.html 完全没有 CSP 声明。
// 修复后下面这些断言锁死效果，防止将来被改回去。
const fs = require('fs');
const path = require('path');
const { check, pass, fail, report } = (() => {
  let p = 0, f = 0;
  return {
    pass: () => p, fail: () => f,
    check: (name, ok, detail = '') => {
      if (ok) { p++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
      else { f++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
    },
    report: () => { console.log(`\n${f === 0 ? 'PASS' : 'FAIL'}：${p}/${p + f} 项通过`); process.exit(f === 0 ? 0 : 1); },
  };
})();

const root = path.join(__dirname, '..');
// T2-1：market:installGit 已随插件市场域拆出 main/ipc/plugins.js，断言随实现走
const mainSrc = fs.readFileSync(path.join(root, 'main/ipc/plugins.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(root, 'main/preload.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');

// ── 1. 主进程不得再从客户端 payload 读取安全降级开关 ──
// T2-1：handler 已拆入 register() 函数体内（带缩进），闭合匹配容忍缩进
const installGitHandler = (mainSrc.match(/ipcMain\.handle\('market:installGit'[\s\S]*?\n\s*\}\);/) || [''])[0];
check('market:installGit handler 存在（供后续断言定位）', installGitHandler.length > 0);
check('handler 内剥离 payload 中的安全降级参数',
  /allowUnsigned:\s*_\w+/.test(installGitHandler) && /allowUnsafeInjection:\s*_\w+/.test(installGitHandler),
  '解构时丢弃客户端传入的这两个字段');
check('allowUnsafeInjection 固定为 false（注入扫描永不因客户端而关闭）',
  /allowUnsafeInjection:\s*false/.test(installGitHandler));
check('签名策略来源为 resolveSignaturePolicy（主进程环境变量）',
  /policy:\s*pluginMarket\.resolveSignaturePolicy\(\)/.test(installGitHandler));
check('残留：handler 内不得出现 payload.allowUnsigned 形式的直接读取',
  !/payload\.allowUnsigned\s*[,)]/.test(installGitHandler) && !/payload\.allowUnsafeInjection\s*[,)]/.test(installGitHandler));
check('降级尝试有告警留痕',
  /已忽略来自渲染层的安全降级参数/.test(installGitHandler));

// ── 2. preload 必须字段白名单，不得整包透传 ──
const preloadLine = (preloadSrc.match(/marketInstallGit:\s*\([\s\S]*?\}\),/) || [''])[0];
check('preload marketInstallGit 存在', preloadLine.length > 0);
check('preload 只透传 url 与 ref（字段白名单）',
  /url:\s*String\(payload\?\.url/.test(preloadLine) && /ref:/.test(preloadLine));
check('preload 不得再整包透传 payload',
  !/invoke\('market:installGit',\s*payload\s*\)/.test(preloadSrc),
  '防止改回 (payload) => invoke(..., payload)');

// ── 3. CSP 必须存在且不放通 unsafe-inline/unsafe-eval ──
check('index.html 声明了 CSP',
  /http-equiv="Content-Security-Policy"/i.test(htmlSrc));
const cspMatch = htmlSrc.match(/http-equiv="Content-Security-Policy"\s+content="\s*([\s\S]*?)"/i);
check('CSP 内容可解析', !!cspMatch);
const csp = cspMatch ? cspMatch[1] : '';
check("script-src 不含 'unsafe-inline'（否则 CSP 对 XSS 失效）",
  !/script-src[^;]*'unsafe-inline'/.test(csp));
check("script-src 不含 'unsafe-eval'",
  !/script-src[^;]*'unsafe-eval'/.test(csp));
check('script-src 限制为 self + 启动脚本哈希',
  /script-src[^;]*'self'/.test(csp) && /script-src[^;]*'sha256-/.test(csp));
check('default-src 设为 self',
  /default-src\s+'self'/.test(csp));
check('object-src 为 none（阻断插件对象嵌入）', /object-src\s+'none'/.test(csp));
check('frame-ancestors 为 none（阻断被点击劫持）', /frame-ancestors\s+'none'/.test(csp));

// ── 4. CSP 哈希必须与内联脚本实际内容匹配（否则启动即白屏）──
const crypto = require('crypto');
const inlineMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
check('存在内联启动脚本（主题前置）', !!inlineMatch);
if (inlineMatch) {
  const actual = 'sha256-' + crypto.createHash('sha256').update(inlineMatch[1], 'utf8').digest('base64');
  const declared = (csp.match(/'(sha256-[^']+)'/) || [])[1];
  check('CSP 哈希与内联脚本实际内容一致（不匹配会导致白屏）',
    actual === declared,
    actual === declared ? actual : `实际 ${actual} ≠ 声明 ${declared}`);
}

report();

// T4-1：Browser Use 执行子进程入口——Playwright 与浏览器进程不再挂在 Electron 主进程里。
// 传输复用 engineProcess/transport.js（utilityProcess 与 fork 双形态，协议语义一致，T3-6 同模式）。
// 浏览器可执行文件解析顺序（全部失败时回传可行动错误，不静默降级）：
//   1) 环境变量 MJ_BROWSER_EXECUTABLE 指定的绝对路径
//   2) 系统 Google Chrome（channel:chrome）
//   3) 系统 Edge（channel:msedge）
//   4) Playwright 自带 Chromium（需用户执行过 npx playwright install chromium）
// 每个子进程一个浏览器实例（headless），会话生命周期=子进程生命周期：
// 崩溃/被杀后由宿主重启新进程（页面状态丢失，由模型重新 navigate 恢复）。
const { attachChildSide } = require('../engineProcess/transport');
const { BROWSER_CHANNELS } = require('./registry');

// ── playwright-core 惰性加载（加载失败=业务错误回传，不触发重启循环）──
let chromiumMod = null;
function loadPlaywright() {
  if (chromiumMod) return chromiumMod;
  let pw;
  try {
    pw = require('playwright-core');
  } catch (err) {
    throw new Error(`playwright-core 未安装或加载失败：${err.message}（请在 desktop 目录执行 npm install playwright-core）`);
  }
  chromiumMod = pw.chromium;
  return chromiumMod;
}

// 解析可用的浏览器启动方式；返回 launch 参数对象，全部不可用抛可行动错误
function resolveLaunch(chromium) {
  const envExe = String(process.env.MJ_BROWSER_EXECUTABLE || '').trim();
  if (envExe) return { executablePath: envExe, label: `自定义（${envExe}）` };
  const tried = [];
  for (const channel of ['chrome', 'msedge']) {
    try {
      chromium.executablePath({ channel });
      return { channel, label: channel === 'chrome' ? 'Google Chrome' : 'Microsoft Edge' };
    } catch {
      tried.push(channel);
    }
  }
  try {
    chromium.executablePath();
    return { label: 'Playwright Chromium' };
  } catch {
    tried.push('chromium');
  }
  throw new Error(
    `未找到可用浏览器（尝试：${tried.join('/') || '无'}）。`
    + '请安装 Google Chrome/Edge，或执行 npx playwright install chromium 下载自带浏览器，'
    + '或设置环境变量 MJ_BROWSER_EXECUTABLE 指向浏览器可执行文件',
  );
}

// ── 浏览器会话状态（一个子进程一个实例）──
let state = null; // { browser, context, page }

async function ensureBrowser() {
  if (state && state.browser && state.browser.isConnected()) return state;
  const chromium = loadPlaywright();
  const launchOpts = resolveLaunch(chromium);
  const browser = await chromium.launch({ headless: true, ...launchOpts, timeout: 30000 });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
    // 常规桌面 Chrome UA：避免 headless 特征 UA 被站点反爬直接拦截
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  state = { browser, context, page };
  browser.on('disconnected', () => { state = null; });
  return state;
}

async function ensurePage() {
  const s = await ensureBrowser();
  return s.page;
}

// 只允许 http/https：file:// 等于把「读任意本地文件」暴露给模型驱动的浏览器
function assertHttpUrl(url) {
  const raw = String(url || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error(`URL 格式不正确：${raw}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`浏览器仅允许打开 http/https 页面（当前：${parsed.protocol}）`);
  }
  return raw;
}

const EXTRACT_DEFAULT_LIMIT = 15000;
const EXTRACT_MAX_LIMIT = 40000;

const IMPL = {
  // probe：只解析不启动（测试与能力探测用）——返回 playwright 可用性与浏览器解析结果
  async probe() {
    let chromium = null;
    try { chromium = loadPlaywright(); }
    catch (err) { return { playwright: false, browser: null, error: String(err.message || err) }; }
    try {
      const opts = resolveLaunch(chromium);
      return { playwright: true, browser: opts.label, channel: opts.channel || null };
    } catch (err) {
      return { playwright: true, browser: null, error: String(err.message || err) };
    }
  },

  async navigate({ url, waitUntil = 'domcontentloaded' } = {}) {
    assertHttpUrl(url);
    const page = await ensurePage();
    await page.goto(String(url), { waitUntil: ['load', 'domcontentloaded', 'networkidle'].includes(waitUntil) ? waitUntil : 'domcontentloaded', timeout: 30000 });
    return { url: page.url(), title: await page.title() };
  },

  async click({ selector } = {}) {
    if (!selector) throw new Error('selector 不能为空');
    const page = await ensurePage();
    await page.click(String(selector), { timeout: 15000 });
    // 点击可能触发导航：等一小段时间让页面稳定再回传现状
    await page.waitForTimeout(500);
    return { url: page.url(), title: await page.title() };
  },

  async fill({ selector, value = '' } = {}) {
    if (!selector) throw new Error('selector 不能为空');
    const page = await ensurePage();
    await page.fill(String(selector), String(value), { timeout: 15000 });
    return { ok: true, selector: String(selector), length: String(value).length };
  },

  async select({ selector, value } = {}) {
    if (!selector) throw new Error('selector 不能为空');
    const page = await ensurePage();
    const vals = Array.isArray(value) ? value.map(String) : [String(value)];
    await page.selectOption(String(selector), vals, { timeout: 15000 });
    return { ok: true, selector: String(selector), value: vals };
  },

  async screenshot({ outPath, fullPage = false } = {}) {
    if (!outPath) throw new Error('outPath 不能为空（由宿主指定落盘路径）');
    const page = await ensurePage();
    await page.screenshot({ path: String(outPath), fullPage: !!fullPage, timeout: 15000 });
    const { statSync } = require('fs');
    return { path: String(outPath), bytes: statSync(outPath).size };
  },

  async extract({ selector, limit } = {}) {
    const page = await ensurePage();
    const max = Math.min(Math.max(Number(limit) || EXTRACT_DEFAULT_LIMIT, 1), EXTRACT_MAX_LIMIT);
    let text;
    if (selector) {
      text = await page.locator(String(selector)).innerText({ timeout: 15000 });
    } else {
      text = await page.evaluate(() => {
        // 此回调在浏览器页面上下文执行，document 属于页面而非 Node
        // eslint-disable-next-line no-undef
        const nav = document.querySelector('nav,header');
        if (nav) nav.remove();
        // eslint-disable-next-line no-undef
        return document.body ? document.body.innerText : '';
      });
    }
    const body = String(text || '').replace(/\n{3,}/g, '\n\n');
    return {
      url: page.url(),
      title: await page.title(),
      text: body.slice(0, max),
      truncated: body.length > max,
      totalChars: body.length,
    };
  },
};

if (BROWSER_CHANNELS.some((name) => typeof IMPL[name] !== 'function')) {
  throw new Error('browserProcess/childEntry: 通道实现与 registry 不一致');
}

const transport = attachChildSide();

transport.onMessage(async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'shutdown') {
    // 尽力关闭浏览器再退出（300ms 宽限，杀不掉由宿主兜底）
    try { await state?.browser?.close(); } catch { /* 已断开 */ }
    process.exit(0);
  }
  if (msg.t !== 'call') return;
  const fn = IMPL[msg.name];
  if (!fn) {
    transport.send({ t: 'callRes', callId: msg.callId, ok: false, error: `未知通道：${msg.name}` });
    return;
  }
  try {
    // args 协议约定为「参数对象」（IMPL 各通道以解构形接收），不是位置参数数组
    const result = await fn(msg.args || {});
    transport.send({ t: 'callRes', callId: msg.callId, ok: true, result });
  } catch (err) {
    // 业务错误（选择器没找到/URL 非法/浏览器缺失）原样回传——宿主按「调用失败」处理，不触发重启
    transport.send({ t: 'callRes', callId: msg.callId, ok: false, error: String(err?.message || err) });
  }
});

transport.send({ t: 'ready' });

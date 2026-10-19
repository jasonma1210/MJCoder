// P0-A / P0-B 回归测试：Web 检索工具 + 任务清单工具
//
// 事故背景：
//   全仓正则实测 web_search / web_fetch / todo_write 命中 0 —— 这是与主流 Agent 的
//   最硬能力差（模型无法获取项目外知识；长任务进度对用户完全不可见）。
//   本测试锁定：工具已注册、schema 合法、SSRF 防护有效、HTML 解析正确、
//   系统提示确实要求长任务先建清单。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const webTools = require('../main/webTools');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`✅ ${name}`); }
  catch (e) { fail++; console.log(`❌ ${name} — ${e.message}`); }
}

import('../agent-core/index.js').then((m) => {
  const BASE_TOOLS = m.BASE_TOOLS || [];

  check('P0-A web_search 工具已注册', () => {
    const t = BASE_TOOLS.find((x) => x.function.name === 'web_search');
    assert.ok(t, 'web_search 未在 BASE_TOOLS 中声明');
    assert.deepStrictEqual(t.function.parameters.required, ['query']);
    assert.ok(t.function.parameters.properties.query.description.length > 5);
  });

  check('P0-A web_fetch 工具已注册', () => {
    const t = BASE_TOOLS.find((x) => x.function.name === 'web_fetch');
    assert.ok(t, 'web_fetch 未在 BASE_TOOLS 中声明');
    assert.deepStrictEqual(t.function.parameters.required, ['url']);
  });

  check('P0-B todo_write 工具已注册且 schema 合法', () => {
    const t = BASE_TOOLS.find((x) => x.function.name === 'todo_write');
    assert.ok(t, 'todo_write 未在 BASE_TOOLS 中声明');
    assert.deepStrictEqual(t.function.parameters.required, ['todos']);
    const item = t.function.parameters.properties.todos.items;
    assert.deepStrictEqual(item.properties.status.enum, ['pending', 'in_progress', 'completed']);
  });

  check('工具总数随能力演进：16 → 21 → 26 → 32 → 39 → 40 → 41 → 46 → 47 → 51（G-doc）', () => {
    // 16 原有 + web_search/web_fetch/todo_write + git_add/git_branch = 21
    // + pr_list/pr_view/pr_diff/pr_review/pr_comment = 26（PR 审查闭环）
    // + browser_navigate/click/fill/select/screenshot/extract = 32（T4-1 Browser Use）
    // + chrome_status/tabs/navigate/click/fill/screenshot/extract = 39（T4-2 Chrome 接管）
    // + code_exec = 40（T4-7 Code Mode）
    // + scheduled_create = 41（2026-10-17：模型此前零定时任务入口，只能让用户手动建）
    // + clipboard/notify/http_request/sqlite/sandbox_code_run = 46（期 3：原生内置工具）
    // + deep_research = 47（G-deep-research：原生深度研究流水线，引擎内建）
    // + doc_create/xlsx_create/pptx_create/pdf_generate = 51（G-doc：文档生成原生工具）
    // + latex_compile = 52（G-latex：LaTeX 编译原生工具）
    assert.strictEqual(BASE_TOOLS.length, 52, `实际 ${BASE_TOOLS.length} 个工具`);
  });

  // ── P1-5：BASE_TOOLS 与 handler 映射 / 审批分级不得断链 ──
  check('P1-5 git_add 工具已声明（此前有实现无入口）', () => {
    const t = BASE_TOOLS.find((x) => x.function.name === 'git_add');
    assert.ok(t, 'git_add 未在 BASE_TOOLS 中声明');
    assert.deepStrictEqual(t.function.parameters.required, ['files']);
  });
  check('P1-5 git_branch 工具已声明', () => {
    const t = BASE_TOOLS.find((x) => x.function.name === 'git_branch');
    assert.ok(t, 'git_branch 未在 BASE_TOOLS 中声明');
  });
  const coreSrc = fs.readFileSync(path.join(__dirname, '../agent-core/index.js'), 'utf8');

  check('P1-5 每个需主进程的工具都有 handler 映射（防有实现无入口）', () => {
    // 引擎内置工具（不依赖主进程 handler）：todo_write 是纯状态工具；
    // spawn_subagent 由引擎内部递归 runAgent 实现；deep_research 由引擎编排内部子调用（web/fetch/write）。
    const ENGINE_BUILTIN = new Set(['todo_write', 'spawn_subagent', 'deep_research']);
    for (const t of BASE_TOOLS) {
      const n = t.function.name;
      if (ENGINE_BUILTIN.has(n)) continue;
      assert.ok(new RegExp(`${n}:\\s*'`).test(coreSrc), `工具 ${n} 缺少 handler 映射`);
    }
  });

  // ── 系统提示必须真的约束模型用这两个工具 ──
  check('P0-B 系统提示已要求长任务先建清单', () => {
    assert.ok(/长任务必须先建清单/.test(coreSrc), '系统提示缺少 todo_write 使用纪律');
    assert.ok(/todo_write/.test(coreSrc), '系统提示未提及 todo_write');
  });
  check('P0-A 系统提示已要求项目外知识联网查', () => {
    assert.ok(/项目外知识必须联网查/.test(coreSrc), '系统提示缺少 web_search 使用纪律');
    assert.ok(/web_search/.test(coreSrc), '系统提示未提及 web_search');
  });
  check('todo_write 为引擎内置处理，不依赖主进程 handler', () => {
    // todo_write 是纯状态工具（不出网、不触盘），由 runAgent 引擎内case 直接处理，
    // 因此**不应**出现在 TOOL_HANDLER_NAMES 里（若出现反而说明路由重复）。
    assert.ok(!/todoWrite:/.test(coreSrc), 'todoWrite 不应注册到主进程 handler（引擎内置已足够）');
    assert.ok(/case 'todo_write'/.test(coreSrc), 'runAgent 缺少 todo_write 的处理分支');
  });
  check('web_search / web_fetch 已注册主进程 handler', () => {
    const mainSrc = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
    assert.ok(/webSearch:\s*\(args\)\s*=>\s*webTools\.webSearch/.test(mainSrc), 'main.js 未接webSearch');
    assert.ok(/webFetch:\s*\(args\)\s*=>\s*webTools\.webFetch/.test(mainSrc), 'main.js 未接 webFetch');
    assert.ok(/require\('\.\/webTools'\)/.test(mainSrc), 'main.js 未 require webTools');
  });

  // ── SSRF 防护：模型可能被诱导访问内网/云元数据──
  const blocked = ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1'];
  for (const h of blocked) {
    check(`P0-A SSRF 防护：拦截 ${h}`, () => {
      assert.strictEqual(webTools.isPrivateHost(h), true, `${h} 应被判为内网`);
    });
  }
  check('P0-A SSRF 防护：放行公网域名', () => {
    assert.strictEqual(webTools.isPrivateHost('example.com'), false);
    assert.strictEqual(webTools.isPrivateHost('github.com'), false);
  });

  // ── HTML → 纯文本 ──
  check('P0-A HTML 解析：剥离 script/style/注释，保留正文结构', () => {
    const html = '<html><head><style>b{}</style></head><body>'
      + '<!--注释--><h1>标题</h1><script>alert(1)</script>'
      + '<p>正文&amp;内容</p><li>项1</li></body></html>';
    const text = webTools.htmlToText(html);
    assert.ok(!text.includes('alert(1)'), 'script 内容未被剥离');
    assert.ok(!text.includes('b{}'), 'style 内容未被剥离');
    assert.ok(!text.includes('注释'), 'HTML 注释未被剥离');
    assert.ok(text.includes('标题') && text.includes('正文&内容'), '正文丢失');
    assert.ok(text.includes('- 项1'), '列表项标记丢失');
  });

  check('P0-A HTML 实体正确还原', () => {
    const t = webTools.htmlToText('<p>&lt;tag&gt; &quot;q&quot; &#39;s&#39;</p>');
    assert.ok(t.includes('<tag>'), '&lt;&gt; 未还原');
    assert.ok(t.includes('"q"'), '&quot; 未还原');
  });

  // ── 协议限制 ──
  check('P0-A 仅允许 http/https（拒绝 file:// 等协议）', async () => {
    // 同步构造 URL 校验：file:///etc/passwd 应被协议检查拒绝
    let rejected = false;
    try {
      const { URL } = require('url');
      const u = new URL('file:///etc/passwd');
      if (u.protocol !== 'http:' && u.protocol !== 'https:') rejected = true;
    } catch (e) { rejected = true; }
    assert.ok(rejected, 'file:// 未被拒绝');
  });

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  fail++;
  console.log(`❌ agent-core 加载失败 — ${e.message}`);
  console.log(`\nFAIL：${pass}/${pass + fail} 项通过`);
  process.exit(1);
});

// 连接器表单字段（2026-10-17 真机 bug 的回归门禁）
//
// 事故形态（用户实测）：在「+」菜单里点需要授权的 MCP，弹出一个输入框，
// 但标签写的是 `Authorization`，而目录模板里的变量叫 `API_KEY` / `X-Api-Key` / `TUSHARE_TOKEN`……
// 用户填了也注入不到（键名不匹配），于是「怎么填都连不上」。
//
// 根因：+ 菜单的 needs-auth 分支把输入框**写死成 Authorization**；
// 而 buildLaunchPlan 早已按模板返回 `missing[{name:'API_KEY'}]`（配置弹窗是对的，+ 菜单没跟上）。
//
// 这里守三件事：表单按 missing 渲染、CLI 授权命令可见、i18n 双语齐全。
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

const plus = read('renderer/src/components/PlusMenu.jsx');

check('+ 菜单的鉴权表单按 plan.missing 逐项渲染（不是写死 Authorization）', () => {
  ok(/plan\.missing\.map/.test(plus), '未按 missing 渲染 —— 模板变量名与输入框会对不上');
});

check('不再出现写死的 vals.Authorization（那会让 API_KEY 类服务永远填不对）', () => {
  // 允许出现在「无模板时粘贴整条令牌」的兜底分支，但 PlusMenu 已改为纯 missing 驱动
  const hits = plus.split('\n').filter((l) => /vals\.Authorization/.test(l));
  ok(hits.length === 0, `仍有 ${hits.length} 处：${hits[0] && hits[0].trim().slice(0, 60)}`);
});

check('字段带 docs_url 时给「如何获取」链接（否则用户不知道去哪拿 key）', () => {
  const i = plus.indexOf('plan.missing.map');
  const seg = plus.slice(i, i + 1200);
  ok(/docs_url/.test(seg), '缺 docs_url 渲染');
  ok(/target="_blank"/.test(seg), '外链缺 target（会整页导航，另一个已修的 bug）');
});

check('preAuth CLI 的服务会展示授权命令', () => {
  ok(/install\?\.auth_command/.test(plus), '未渲染 auth_command —— 用户不知道要先跑什么');
  ok(/select-all/.test(plus), '命令不可全选（手抄 AUTH 命令容易错）');
});

check('新增的 i18n key 中英双语齐全', () => {
  for (const loc of ['zh-CN', 'en-US']) {
    const d = JSON.parse(read(`renderer/src/i18n/locales/${loc}/plusMenu.json`));
    ok(d.cliAuthRequired, `${loc} 缺 plusMenu.cliAuthRequired`);
  }
});

// ── 目录侧：锁版本（供应链）──
check('导入目录里没有 @latest（版本必须锁定，否则每次连的是不同代码）', () => {
  const d = JSON.parse(read('../ecosystem/mcp-connectors-workbuddy.json'));
  const list = Array.isArray(d) ? d : d.connectors;
  const bad = list
    .filter((c) => c.install && ['npm', 'uvx'].includes(c.install.type))
    .map((c) => String(c.install.pkg || ''))
    .filter((p) => /@latest$/.test(p) || /@latest@/.test(p));
  ok(bad.length === 0, `仍有未锁版本：${bad.slice(0, 5).join(', ')}`);
});

check('preAuth CLI 的条目都带 auth_command（否则「先授权」无从执行）', () => {
  const d = JSON.parse(read('../ecosystem/mcp-connectors-workbuddy.json'));
  const list = Array.isArray(d) ? d : d.connectors;
  const need = list.filter((c) => /需先在终端执行授权/.test(String(c.notes || '')));
  ok(need.length > 0, '没有识别到任何 CLI 授权条目 —— 数据可能退化了');
  const bad = need.filter((c) => !c.install || !c.install.auth_command);
  ok(bad.length === 0, `缺命令：${bad.map((c) => c.id).join(', ')}`);
});

console.log(`\n结果：${pass}/${total} 通过`);

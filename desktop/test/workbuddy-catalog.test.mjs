// WorkBuddy 导入目录 + 合并加载（2026-10-17）
//
// 为什么单独一个套件：主目录 `mcp-connectors.json` 有「≤90 条」的收敛门禁
//（test/connector-catalog.test.mjs 守护），导入的 203 条放在
// `mcp-connectors-workbuddy.json`，由 main/ecosystem.js 合并加载。
// 这里守三件事：
//   ① 导入文件自身的数据质量（与主目录同一套不变式）；
//   ② 合并加载真的读到了两个来源、且精选优先去重；
//   ③ 每条都有「能被启动或用得上的形状」，不制造点不动的条目。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const ECOSYSTEM = path.join(ROOT, '..', 'ecosystem');
const WB_FILE = path.join(ECOSYSTEM, 'mcp-connectors-workbuddy.json');
const MAIN_FILE = path.join(ECOSYSTEM, 'mcp-connectors.json');
const { loadMcpConnectors } = require(path.join(ROOT, 'main/ecosystem.js'));

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

const raw = JSON.parse(fs.readFileSync(WB_FILE, 'utf8'));
const list = Array.isArray(raw) ? raw : raw.connectors;
const curated = (() => {
  const d = JSON.parse(fs.readFileSync(MAIN_FILE, 'utf8'));
  return Array.isArray(d) ? d : d.connectors;
})();

check('导入文件存在、可解析、来源标注正确', () => {
  ok(Array.isArray(list) && list.length > 0, `条目为空：${list && list.length}`);
  ok(raw.source === 'workbuddy-connectors-marketplace', `source=${raw.source}`);
});

check('全部 id 带 wb- 前缀（与精选目录可区分，避免 id 冲突）', () => {
  const bad = list.filter((c) => !String(c.id || '').startsWith('wb-')).map((c) => c.id);
  ok(bad.length === 0, `未加前缀：${bad.slice(0, 5).join(', ')}`);
});

check('id / name 均唯一', () => {
  const dup = (k) => {
    const seen = new Set();
    const d = [];
    for (const c of list) {
      const v = String(c[k] || '').toLowerCase();
      if (!v) continue;
      if (seen.has(v)) d.push(v);
      seen.add(v);
    }
    return d;
  };
  ok(dup('id').length === 0, `重复 id：${dup('id').slice(0, 3).join(', ')}`);
  ok(dup('name').length === 0, `重复 name：${dup('name').slice(0, 3).join(', ')}`);
});

check('install 类型合法，且 launchable 的都有启动信息', () => {
  const VALID = new Set(['npm', 'uvx', 'docker', 'remote', 'manual']);
  const badType = list.filter((c) => !VALID.has(String(c.install?.type || '').toLowerCase()));
  ok(badType.length === 0, `非法类型：${badType.slice(0, 3).map((c) => `${c.id}:${c.install?.type}`).join(', ')}`);
  const noUrl = list.filter((c) => c.install?.type === 'remote' && !c.install?.url);
  ok(noUrl.length === 0, `remote 缺 url：${noUrl.slice(0, 3).map((c) => c.id).join(', ')}`);
  const noPkg = list.filter((c) => ['npm', 'uvx'].includes(c.install?.type) && !c.install?.pkg);
  ok(noPkg.length === 0, `npm/uvx 缺 pkg：${noPkg.slice(0, 3).map((c) => c.id).join(', ')}`);
});

check('manual 条目必须声明 env_vars（否则点开无处可填）', () => {
  const bad = list
    .filter((c) => c.install?.type === 'manual')
    .filter((c) => !(Array.isArray(c.env_vars) && c.env_vars.length))
    .map((c) => c.id);
  ok(bad.length === 0, `manual 无字段：${bad.slice(0, 5).join(', ')}`);
});

check('声明 paste_key 就必须有注入通道（env_vars / url / ${VAR} 占位符）', () => {
  const channels = (c) => {
    const ch = [];
    if (Array.isArray(c.env_vars) && c.env_vars.length) ch.push('env_vars');
    if (c.install?.url) ch.push('url');
    if (c.install?.headers && Object.keys(c.install.headers).length) ch.push('headers');
    return ch;
  };
  const bad = list.filter((c) => c.auth_mode === 'paste_key' && channels(c).length === 0).map((c) => c.id);
  ok(bad.length === 0, bad.slice(0, 5).join(', '));
});

check('header 模板里的变量必须出现在 env_vars 里（否则表单不会问用户要）', () => {
  const bad = [];
  for (const c of list) {
    const tpl = c.install?.headers || {};
    for (const v of Object.values(tpl)) {
      for (const m of String(v).matchAll(/\$\{(\w+)\}/g)) {
        const name = m[1];
        const declared = (c.env_vars || []).some((e) => e.name === name);
        if (!declared) bad.push(`${c.id}:${name}`);
      }
    }
  }
  ok(bad.length === 0, `模板变量未声明：${bad.slice(0, 5).join(', ')}`);
});

check('SSE 条目必须显式标 transport=sse（避免被当 streamableHttp 直连后超时）', () => {
  const bad = list.filter((c) => c.notes && /SSE 传输/.test(c.notes) && c.transport !== 'sse').map((c) => c.id);
  ok(bad.length === 0, bad.slice(0, 3).join(', '));
});

check('URL 里带 ${VAR} 的条目必须声明为 paste_key 且列出该变量', () => {
  const bad = [];
  for (const c of list) {
    const url = String(c.install?.url || '');
    const vars = [...url.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]);
    if (!vars.length) continue;
    if (c.auth_mode !== 'paste_key') { bad.push(`${c.id}(auth=${c.auth_mode})`); continue; }
    for (const v of vars) {
      if (!(c.env_vars || []).some((e) => e.name === v)) bad.push(`${c.id} 缺变量 ${v}`);
    }
  }
  ok(bad.length === 0, `URL 带 key 却没让用户填：${bad.slice(0, 5).join(', ')}`);
});

check('有 token-schema 的条目应带中文 label 与文档链接（不是裸变量名）', () => {
  const withDocs = list.filter((c) => (c.env_vars || []).some((v) => v.docs_url));
  ok(withDocs.length > 0, '没有任何条目带 docs_url —— schema 合并失效');
  const bare = list.filter((c) => (c.env_vars || []).length > 0 && (c.env_vars || []).every((v) => v.label === v.name));
  ok(bare.length < list.length * 0.5, `仍有过半条目用裸变量名作 label（${bare.length}/${list.length}）`);
});

check('合并加载：两个来源都读到，且精选优先去重', () => {
  const merged = loadMcpConnectors(ECOSYSTEM);
  const fromCurated = merged.filter((c) => c.source === 'curated');
  const fromWb = merged.filter((c) => c.source === 'workbuddy');
  ok(fromCurated.length === curated.length, `精选 ${fromCurated.length} ≠ 文件 ${curated.length}`);
  ok(fromWb.length > 0, '未读到 WorkBuddy 来源');
  ok(merged.length <= curated.length + list.length, '合并后条数超过两文件之和（去重逻辑异常）');
  const ids = new Set(merged.map((c) => c.id));
  ok(ids.size === merged.length, '合并后有重复 id');
});

check('合并加载：同一 url 只保留一条（精选优先）', () => {
  const merged = loadMcpConnectors(ECOSYSTEM);
  const urls = merged
    .map((c) => (c.install?.url ? String(c.install.url).replace(/\/+$/, '').toLowerCase() : ''))
    .filter(Boolean);
  ok(new Set(urls).size === urls.length, '合并后存在重复 url');
});

check('主目录仍受「≤90 条」门禁保护（导入不得撑大精选目录）', () => {
  ok(curated.length <= 90, `精选目录 ${curated.length} 条，超过上限`);
});

console.log(`\n结果：${pass}/${total} 通过（导入 ${list.length} 条 + 精选 ${curated.length} 条）`);

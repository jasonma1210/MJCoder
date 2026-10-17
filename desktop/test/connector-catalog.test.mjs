// 连接器目录规范门禁（ecosystem/mcp-connectors.json）
//
// 为什么需要它（2026-10-16 用户反馈：「ima 点配置应该能输入它要求的凭证，现在啥都没有了」）：
// 目录条目声明的 `auth_mode` 与 `install.type` 共同决定弹窗形态。若某条目标了
// `auth_mode: 'paste_key'`（= 需要用户提供密钥）却**没有任何注入通道**
// （env_vars / install.url / args 里的 ${VAR} 占位符），用户点开配置会看到一个
// 「说要填 Key、却无处可填」的空弹窗 —— 这类不一致会让连接器**永远连不上**，
// 而且表现是静默的（界面不报错、只是没输入框）。本门禁把这一类变成红灯。
//
// 规则（对**可自动启动**的 install.type：npm / uvx / docker / remote）：
//   auth_mode === 'paste_key'  ⇒  必须存在至少一条注入通道：
//       ① env_vars 非空；或
//       ② install.url 非空（远程端点自带鉴权入口）；或
//       ③ install.args 中出现 ${VAR} 占位符（启动计划会自动生成输入表单）。
//   `manual` 类型不在本条约束内 —— 它本身不启动、只给指引，`auth_mode` 仅作元数据。
//
// 另外校验所有条目的自洽性：install.type 合法、npm/uvx 必须有 pkg、
//   remote 必须有 url、id/name 不重复。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass += 1; }
  catch (e) { console.error(`❌ ${name} — ${e.message}`); fail += 1; }
}

const FILE = path.join(import.meta.dirname, '..', '..', 'ecosystem', 'mcp-connectors.json');
const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const list = Array.isArray(raw) ? raw : raw.connectors;
const LAUNCHABLE = new Set(['npm', 'uvx', 'docker', 'remote']);
const VALID_TYPES = new Set(['npm', 'uvx', 'docker', 'remote', 'manual']);

const hasPlaceholder = (c) => (c.install?.args || []).some((a) => /\$\{\w+\}/.test(String(a)));
const injectionChannels = (c) => {
  const ch = [];
  if (Array.isArray(c.env_vars) && c.env_vars.length) ch.push('env_vars');
  if (c.install?.url) ch.push('url');
  if (hasPlaceholder(c)) ch.push('args-placeholder');
  return ch;
};

check('目录可解析且条目数 > 0', () => {
  assert.ok(Array.isArray(list) && list.length > 0, `实际 ${list?.length}`);
});

check('install.type 取值合法', () => {
  const bad = list.filter((c) => !VALID_TYPES.has(String(c.install?.type || '').toLowerCase()))
    .map((c) => `${c.id}:${c.install?.type}`);
  assert.deepEqual(bad, [], `非法类型: ${bad.join(', ')}`);
});

check('npm/uvx 条目必须有包名', () => {
  const bad = list.filter((c) => ['npm', 'uvx'].includes(String(c.install?.type || '')) && !c.install?.pkg)
    .map((c) => c.id);
  assert.deepEqual(bad, [], `缺 pkg: ${bad.join(', ')}`);
});

check('remote 条目必须有 url', () => {
  const bad = list.filter((c) => String(c.install?.type || '') === 'remote' && !c.install?.url).map((c) => c.id);
  assert.deepEqual(bad, [], `缺 url: ${bad.join(', ')}`);
});

check('id 与 name 不重复', () => {
  const dup = (key) => {
    const seen = new Set();
    const out = [];
    for (const c of list) {
      const v = String(c[key] || '');
      if (!v) continue;
      if (seen.has(v)) out.push(v);
      seen.add(v);
    }
    return out;
  };
  assert.deepEqual(dup('id'), [], '重复 id');
  assert.deepEqual(dup('name'), [], '重复 name');
});

// ── 核心不变式：可自动启动 + 需要粘贴密钥 ⇒ 必须有注入通道 ──
check('可自动启动且 paste_key 的条目必须有注入通道（env_vars / url / ${VAR} 占位符）', () => {
  const bad = list
    .filter((c) => LAUNCHABLE.has(String(c.install?.type || '').toLowerCase()))
    .filter((c) => String(c.auth_mode || '') === 'paste_key')
    .filter((c) => injectionChannels(c).length === 0)
    .map((c) => `${c.id}(${c.install.type}) / ${c.display_name}`);
  assert.deepEqual(bad, [],
    `以下条目会渲染出「说要填 Key、却无处可填」的空表单，请补 env_vars 或降级为 manual：\n  ${bad.join('\n  ')}`);
});

check('相关条目已按官方规范补齐（ClickHouse 连接信息 / Kubernetes kubeconfig）', () => {
  const byId = (id) => list.find((c) => c.id === id);
  const ch = byId('mcp-clickhouse');
  assert.ok(ch, '缺少 mcp-clickhouse');
  const names = (ch.env_vars || []).map((v) => v.name);
  for (const need of ['CLICKHOUSE_HOST', 'CLICKHOUSE_USER', 'CLICKHOUSE_PASSWORD']) {
    assert.ok(names.includes(need), `ClickHouse 缺 ${need}`);
  }
  assert.ok((ch.env_vars || []).filter((v) => v.required).length >= 3, 'ClickHouse 至少 3 项必填');

  const k8s = byId('mcp-kubernetes');
  assert.ok(k8s, '缺少 mcp-kubernetes');
  assert.equal(k8s.auth_mode, 'none', 'kubeconfig 凭据不需要粘贴密钥，auth_mode 应为 none');
  assert.ok((k8s.env_vars || []).some((v) => v.name === 'KUBECONFIG'), '应保留可选的 KUBECONFIG 输入');
});

check('env_vars 每项结构完整（name 必填，带 label 或 docs_url 便于用户获取）', () => {
  const bad = [];
  for (const c of list) {
    for (const v of c.env_vars || []) {
      if (!v?.name) { bad.push(`${c.id}: 缺 name`); continue; }
      if (!v.label && !v.docs_url) bad.push(`${c.id}:${v.name} 既无 label 也无 docs_url`);
    }
  }
  assert.deepEqual(bad, [], bad.join('; '));
});

// ── 收录标准（2026-10-16 用户要求「只留主流、加得上的服务」）──
// 规则：要么有自动启动信息（npm/uvx/docker/remote，装上即可连），
//       要么是 manual 但已按官方规范声明所需凭证（用户至少能填、能存）。
// 「manual 且无任何可填字段」= 点开只有一个空指引 → 不应收录。
check('manual 条目必须声明 env_vars（否则点开无处可填，不应收录）', () => {
  const bad = list.filter((c) => String(c.install?.type || '') === 'manual' && !(c.env_vars || []).length)
    .map((c) => `${c.id} / ${c.display_name}`);
  assert.deepEqual(bad, [], `以下 manual 条目无任何可填字段，应移除或补齐官方凭证声明：\n  ${bad.join('\n  ')}`);
});

check('主流服务仍在目录中（飞书 / 钉钉 / Notion）', () => {
  for (const id of ['mcp-lark-feishu', 'mcp-dingtalk', 'mcp-notion']) {
    assert.ok(list.some((c) => c.id === id), `缺少 ${id}`);
  }
});

// 2026-10-17：用户明确要求移除 ima 与 Ardot（不再作为内置连接器出现）。
// 反向断言：将来若有人"顺手加回来"，这里先红。
check('ima / Ardot 已按用户要求移除，不得回流', () => {
  const bad = ['mcp-ima', 'mcp-ardot-remote', 'mcp-ardot-local'].filter((id) => list.some((c) => c.id === id));
  assert.deepEqual(bad, [], `这些条目已要求移除，却又出现了：${bad.join(', ')}`);
});

check('钉钉按官方规范声明凭证（Client ID / Client Secret）', () => {
  const dt = list.find((c) => c.id === 'mcp-dingtalk');
  assert.ok(dt, '缺少 mcp-dingtalk');
  const names = (dt.env_vars || []).map((v) => v.name);
  assert.ok(names.includes('DINGTALK_Client_ID'), '缺 DINGTALK_Client_ID');
  assert.ok(names.includes('DINGTALK_Client_Secret'), '缺 DINGTALK_Client_Secret');
});

check('目录规模已收敛（防止再次膨胀成大量不可用条目）', () => {
  assert.ok(list.length <= 90, `当前 ${list.length} 条，超出收敛上限 90`);
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);

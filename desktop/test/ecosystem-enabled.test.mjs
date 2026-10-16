// 生态启用清单纯函数单测（lib/ecosystemEnabled.ts）
// 覆盖：默认启用集 / 旧下载清单一次性迁移 / 开关读写 / 配置值合并与清空
// 运行：node test/ecosystem-enabled.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOD = pathToFileURL(path.join(ROOT, 'renderer', 'src', 'lib', 'ecosystemEnabled.ts')).href;
const M = await import(MOD);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// 内存 storage 桩（与 localStorage 同接口）
function stubStore(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

const catalog = [
  { id: 'c-rec-1', recommended: true },
  { id: 'c-rec-2', recommended: true },
  { id: 'c-plain' },
];

// ── 默认启用集 ──
const d = M.defaultEnabled(catalog);
check('默认启用=recommended 条目', d.connectors.join(',') === 'c-rec-1,c-rec-2' && d.skills.length === 0);
check('目录缺 recommended 不误入默认集', !d.connectors.includes('c-plain'));

// ── 首次读取：默认集 + 旧下载清单迁移 ──
const s1 = stubStore({
  mj_downloaded_connectors: JSON.stringify([{ id: 'c-plain', name: 'x' }, { id: 'c-plain' }, null]),
});
const st1 = M.loadEnabled(s1, catalog);
check('迁移：旧清单并入默认集且去重', st1.connectors.includes('c-rec-1') && st1.connectors.includes('c-plain')
  && st1.connectors.filter((x) => x === 'c-plain').length === 1, st1.connectors.join(','));
check('迁移后写入启用清单 key', s1.getItem('mj_ecosystem_enabled') != null);
check('迁移后删除旧下载清单 key', s1.getItem('mj_downloaded_connectors') === null);

// 幂等：再次读取不重复迁移（即使旧 key 复活也不该再读——已有记录直接返回）
const s2 = stubStore({ mj_ecosystem_enabled: JSON.stringify({ connectors: ['a'], skills: ['s'] }) });
s2.setItem('mj_downloaded_connectors', JSON.stringify([{ id: 'z' }]));
const st2 = M.loadEnabled(s2, catalog);
check('已有启用记录时直接返回（不再迁移）', st2.connectors.join() === 'a' && st2.skills.join() === 's');
check('已有记录时旧 key 不被误删（零副作用）', s2.getItem('mj_downloaded_connectors') !== null);

// 损坏 JSON 容错回落默认集
const s3 = stubStore({ mj_ecosystem_enabled: '{ broken' });
const st3 = M.loadEnabled(s3, catalog);
check('损坏启用记录回落默认集', st3.connectors.join() === 'c-rec-1,c-rec-2');

// 空目录 + 无旧数据
const s4 = stubStore();
check('全新环境返回空启用集', M.loadEnabled(s4, []).connectors.length === 0);

// ── 开关 ──
const s5 = stubStore();
let st5 = M.loadEnabled(s5, catalog);
st5 = M.setConnectorEnabled(s5, st5, 'c-plain', true);
check('连接器开启生效', st5.connectors.includes('c-plain'));
st5 = M.setConnectorEnabled(s5, st5, 'c-rec-1', false);
check('连接器关闭生效', !st5.connectors.includes('c-rec-1'));
st5 = M.setConnectorEnabled(s5, st5, 'c-plain', true);
check('重复开启不产生重复项', st5.connectors.filter((x) => x === 'c-plain').length === 1);
st5 = M.setSkillEnabled(s5, st5, 'code-review', true);
st5 = M.setSkillEnabled(s5, st5, 'pdf', true);
st5 = M.setSkillEnabled(s5, st5, 'code-review', false);
check('技能开关独立于连接器', st5.skills.join() === 'pdf' && st5.connectors.includes('c-plain'));
check('开关即时落盘', JSON.parse(s5.getItem('mj_ecosystem_enabled')).skills.join() === 'pdf');

// ── 配置值 ──
const s6 = stubStore();
check('无记录时配置值为空对象', Object.keys(M.connectorValuesFor(s6, 'x')).length === 0);
M.saveConnectorValue(s6, 'mcp-lark', 'LARK_APP_ID', 'cli_a');
M.saveConnectorValue(s6, 'mcp-lark', 'Authorization', 'Bearer t');
check('配置值按连接器隔离', M.connectorValuesFor(s6, 'mcp-lark').LARK_APP_ID === 'cli_a'
  && Object.keys(M.connectorValuesFor(s6, 'other')).length === 0);
M.saveConnectorValue(s6, 'mcp-lark', 'LARK_APP_ID', '');
check('空串删除单项', !('LARK_APP_ID' in M.connectorValuesFor(s6, 'mcp-lark'))
  && M.connectorValuesFor(s6, 'mcp-lark').Authorization === 'Bearer t');
M.saveConnectorValue(s6, 'mcp-lark', 'Authorization', '');
check('全部清空后移除连接器条目', !('mcp-lark' in M.loadConnectorValues(s6)));
const s7 = stubStore({ mj_ecosystem_connector_values: 'not-json' });
check('损坏配置值回落空对象', Object.keys(M.loadConnectorValues(s7)).length === 0);

// ── 目录数据契约（T2）：auth_mode 全覆盖 + recommended 精选存在且合法 ──
// 弹窗双轨分流依赖 auth_mode；默认启用集依赖 recommended——目录缺字段 = 功能死路
import fs from 'node:fs';
const catalogRaw = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'ecosystem', 'mcp-connectors.json'), 'utf8'));
const cons = catalogRaw.connectors || [];
check('目录连接器非空', cons.length > 0);
check('auth_mode 全覆盖', cons.every((c) => ['oauth', 'paste_key', 'none'].includes(c.auth_mode)),
  cons.filter((c) => !['oauth', 'paste_key', 'none'].includes(c.auth_mode)).map((c) => c.id).join(','));
// auth_mode 与 auth_type 推导一致性：oauth→oauth；api_key/token→paste_key；none→none
const derive = { oauth: 'oauth', api_key: 'paste_key', token: 'paste_key', none: 'none' };
check('auth_mode 与 auth_type 推导一致', cons.every((c) => c.auth_mode === derive[c.auth_type]),
  cons.filter((c) => c.auth_mode !== derive[c.auth_type]).map((c) => c.id).join(','));
const recs = cons.filter((c) => c.recommended === true);
check('recommended 精选 10~15 条', recs.length >= 10 && recs.length <= 15, `实际 ${recs.length} 条`);
// 用户指定四产品必须在精选默认启用集内（Notion/飞书/ima/Ardot 本地）
const recIds = new Set(recs.map((c) => c.id));
check('精选覆盖用户指定四产品', ['mcp-notion', 'mcp-lark-feishu', 'mcp-ima', 'mcp-ardot-local'].every((id) => recIds.has(id)));
// 默认启用集直接喂真实目录：结果应与 recommended 集一致
const realDefault = M.defaultEnabled(cons);
check('真实目录默认启用=recommended 集', realDefault.connectors.length === recs.length);

const failed = results.filter((x) => !x.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) { console.error('存在失败用例'); process.exit(1); }

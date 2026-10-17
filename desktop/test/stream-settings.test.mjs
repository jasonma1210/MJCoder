// T6 回归门禁：三层超时的用户设置必须「可调、有界、有来源」。
//
// 设计要点（见 main/streamSettings.js 头注释）：
//   · 优先级 用户设置 > 环境变量 > 默认；
//   · 越界**收敛**（填 5 秒 → 收到 10 秒下限），非法值（NaN/负数/0）回落下一优先级；
//   · 每次请求现读，改完立即生效（不重启、不缓存）。
//
// 反向用例：如果 clampMs 退化成"原样返回"，用例③④会红；如果改了设置不生效（缓存），用例⑤会红。
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const { initStreamSettings, getStreamTimeouts, getStreamSettingsView, clampMs, BOUNDS } =
  require(path.join(ROOT, 'main/streamSettings.js'));
const { DEFAULTS } = require(path.join(ROOT, 'main/streamGuard.js'));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.log(`[FAIL] ${name}\n       ${e.message}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

function withStore(prefs) {
  const store = {
    prefs: { ...prefs },
    getPreference(k) { return this.prefs[k]; },
    setPreference(k, v) { this.prefs[k] = v; },
  };
  initStreamSettings({ getLocalStore: () => store });
  return store;
}

check('没有用户设置时等于内置默认（90s / 300s / 900s）', () => {
  withStore({});
  const t = getStreamTimeouts();
  assert(t.firstByteMs === DEFAULTS.firstByteMs, `firstByteMs=${t.firstByteMs}`);
  assert(t.idleMs === DEFAULTS.idleMs, `idleMs=${t.idleMs}`);
  assert(t.totalMs === DEFAULTS.totalMs, `totalMs=${t.totalMs}`);
});

check('用户设置优先生效', () => {
  withStore({ stream_timeouts: { firstByteMs: 120000, idleMs: 600000, totalMs: 3600000 } });
  const t = getStreamTimeouts();
  assert(t.firstByteMs === 120000 && t.idleMs === 600000 && t.totalMs === 3600000, JSON.stringify(t));
});

check('越界收敛到区间内（不是静默忽略）', () => {
  withStore({ stream_timeouts: { firstByteMs: 1000, idleMs: 9e9, totalMs: 5000 } });
  const t = getStreamTimeouts();
  assert(t.firstByteMs === BOUNDS.firstByteMs.min, `下限收敛失败：${t.firstByteMs}`);
  assert(t.idleMs === BOUNDS.idleMs.max, `上限收敛失败：${t.idleMs}`);
  assert(t.totalMs === BOUNDS.totalMs.min, `下限收敛失败：${t.totalMs}`);
});

check('非法值回落默认（0 不等于禁用）', () => {
  withStore({ stream_timeouts: { firstByteMs: 'abc', idleMs: -1, totalMs: 0 } });
  const t = getStreamTimeouts();
  assert(t.firstByteMs === DEFAULTS.firstByteMs, `firstByteMs 回落失败：${t.firstByteMs}`);
  assert(t.idleMs === DEFAULTS.idleMs, `idleMs 回落失败：${t.idleMs}`);
  assert(t.totalMs === DEFAULTS.totalMs, `totalMs 回落失败：${t.totalMs}`);
});

check('改设置立即生效（无缓存——否则用户改完要重启）', () => {
  const store = withStore({});
  assert(getStreamTimeouts().idleMs === DEFAULTS.idleMs, '初始值不对');
  store.setPreference('stream_timeouts', { idleMs: 450000 });
  assert(getStreamTimeouts().idleMs === 450000, '修改后未生效');
});

check('设置页视图带来源、区间与默认值（前端不再硬编码）', () => {
  withStore({ stream_timeouts: { idleMs: 450000 } });
  const v = getStreamSettingsView();
  assert(v.effective.idleMs === 450000, 'effective 不对');
  assert(v.source.idleMs === 'user', `source.idleMs 应为 user，实际 ${v.source.idleMs}`);
  assert(v.source.firstByteMs === 'default', `source.firstByteMs 应为 default，实际 ${v.source.firstByteMs}`);
  assert(v.bounds.idleMs.min === 30000 && v.bounds.idleMs.max === 1800000, '区间不对');
  assert(v.defaults.totalMs === 900000, '默认值不对');
});

check('clampMs 单元：非数字/越界/正常', () => {
  assert(clampMs('idleMs', null) === null, 'null 应返回 null');
  assert(clampMs('idleMs', 'abc') === null, 'NaN 应返回 null');
  assert(clampMs('idleMs', 0) === null, '0 应返回 null');
  assert(clampMs('idleMs', 120000) === 120000, '正常值应原样返回');
  assert(clampMs('unknownKey', 120000) === null, '未知键应返回 null');
});

check('读取偏好抛错时不得放宽超时（回落默认，不回落 0）', () => {
  initStreamSettings({ getLocalStore: () => { throw new Error('store boom'); } });
  const t = getStreamTimeouts();
  assert(t.idleMs === DEFAULTS.idleMs, `异常时应回落默认，实际 ${t.idleMs}`);
});

console.log(`\n结果：${pass}/${total} 通过`);
if (pass !== total) process.exitCode = 1;

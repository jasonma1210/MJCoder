// featureFlags 测试：默认冻结 + 环境变量覆盖 + fail-closed
const { DEFAULTS, loadFeatureFlags } = require('../main/featureFlags');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 默认值：协同/云端/小程序冻结，桌面端能力保留
const d = loadFeatureFlags({});
check('默认冻结 collab', d.collab === false);
check('默认冻结 cloud', d.cloud === false);
check('默认冻结 miniprogram', d.miniprogram === false);
check('默认保留 cua（桌面端能力）', d.cua === true);
check('默认保留 ecosystem', d.ecosystem === true);
check('默认值为冻结对象快照', DEFAULTS.collab === false);

// 环境变量覆盖（显式恢复）
const restored = loadFeatureFlags({ MJCODE_FEATURES: '{"collab":true,"cloud":true}' });
check('合法覆盖恢复 collab', restored.collab === true);
check('合法覆盖恢复 cloud', restored.cloud === true);
check('未覆盖键保持默认', restored.miniprogram === false);

// fail-closed：非法输入一律忽略
check('非法 JSON 忽略并回落默认', loadFeatureFlags({ MJCODE_FEATURES: 'not-json' }).collab === false);
check('数组输入忽略', loadFeatureFlags({ MJCODE_FEATURES: '[1]' }).collab === false);
check('未知键不注入', !('evil' in loadFeatureFlags({ MJCODE_FEATURES: '{"evil":true}' })));
check('非布尔值忽略（字符串 "true" 不生效）', loadFeatureFlags({ MJCODE_FEATURES: '{"collab":"true"}' }).collab === false);
check('空字符串不解析', loadFeatureFlags({ MJCODE_FEATURES: '' }).collab === false);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);

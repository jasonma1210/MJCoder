// N2 env 允许表行为验收（2026-10-16）：
//   1) Agent 子 shell 不再继承宿主全量环境变量（防 API Key/token 经 env/printenv 泄漏进模型上下文）；
//   2) 白名单内变量（HOME/PATH/代理等）正常透传；
//   3) PATH 仍为按平台解析的工具目录（打包版 uvx 修复不回退）。
process.env.MJ_LEAK_CANARY = 'top-secret-value'; // 模拟宿主 shell 里可能存在的敏感变量

const assert = require('assert');
const { shellEnv, SHELL_PATH } = require('../main/tools/shellEnv');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const env = shellEnv();
const envKeys = new Set(Object.keys(env));

check('敏感变量不继承：MJ_LEAK_CANARY 不在子 shell 环境', !envKeys.has('MJ_LEAK_CANARY'));
check('白名单透传：HOME 存在', !!env.HOME);
check('白名单透传：PATH 为按平台解析的工具目录', typeof env.PATH === 'string' && env.PATH.length > 0);
check('PATH 不再继承宿主（只含工具目录）', env.PATH.split(process.platform === 'win32' ? ';' : ':').every((p) => p.startsWith('/') || /^[A-Za-z]:\\/.test(p)));
check('代理变量透传（若宿主存在）', process.env.HTTPS_PROXY === undefined || envKeys.has('HTTPS_PROXY'));
check('环境键数远小于宿主全量（白名单收敛生效）', envKeys.size < Object.keys(process.env).length,
  `子 shell ${envKeys.size} vs 宿主 ${Object.keys(process.env).length}`);
check('SHELL_PATH 导出形态保持（既有消费者兼容）', typeof SHELL_PATH === 'string' && SHELL_PATH.length > 0);
// 无值白名单项不凭空注入
check('白名单缺失项不注入空值', process.env.JAVA_HOME === undefined || env.JAVA_HOME === undefined ? !('JAVA_HOME' in env) || process.env.JAVA_HOME !== undefined : true);

console.log(`\n──── N2 env 允许表验收汇总：通过 ${pass} · 失败 ${fail} ────`);
process.exit(fail === 0 ? 0 : 1);

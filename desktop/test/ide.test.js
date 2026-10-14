// ide 测试：IDE 候选选择纯函数
const { pickIde, IDE_CANDIDATES, FALLBACK } = require('../main/ide');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

check('有 VS Code 时选 code', pickIde('darwin', ['code']).cmd === 'code');
check('无 VS Code 有 cursor 时选 cursor', pickIde('darwin', ['cursor']).cmd === 'cursor');
check('按候选优先级排序', pickIde('darwin', ['cursor', 'code']).cmd === 'code');
check('全部缺失回落系统默认（darwin: open -t）', (() => {
  const r = pickIde('darwin', []);
  return r.cmd === 'open' && r.args.join(',') === '-t' && r.ide === 'system';
})());
check('linux 回落 xdg-open', pickIde('linux', []).cmd === 'xdg-open');
check('win32 候选含 code.cmd', IDE_CANDIDATES.win32.includes('code.cmd'));
check('未知平台回落 linux 候选', pickIde('freebsd', ['code']).cmd === 'code');
check('available 为空/非法不抛错', pickIde('darwin', null).cmd === 'open');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);

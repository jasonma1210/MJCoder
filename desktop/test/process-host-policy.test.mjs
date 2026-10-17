// 三个 process host 的「策略差异」守护（2026-10-17 代码审查 P3-2）。
//
// 为什么需要它：codeProcess / cuaProcess / browserProcess 的 host 有 14 行以上完全相同的
// RPC 桥接代码，看起来该合并；但它们的**故障策略相反**：
//   · code    ：不重启（vm 上下文是状态，静默重建会让模型在「以为状态还在」里继续写代码）
//   · cua     ：透明重启 1 次（原生调用无状态，重试安全）
//   · browser ：只对幂等通道重启（probe/navigate/screenshot/extract；click 这类不重试）
// 合并会把「必须不同」揉成一个开关，正是历史事故的温床。所以这里不测「像不像」，
// 而是把三条策略写成断言：谁改错了策略，这里先红。
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
const num = (src, name) => {
  const m = src.match(new RegExp(`const ${name} = (\\d+)`));
  if (!m) throw new Error(`未找到常量 ${name}`);
  return Number(m[1]);
};

const code = read('main/codeProcess/host.js');
const cua = read('main/cuaProcess/host.js');
const browser = read('main/browserProcess/host.js');

check('code host 不做透明重启（RESTART_MAX 不得出现）', () => {
  ok(!/RESTART_MAX/.test(code), 'code host 出现了 RESTART_MAX——策略被改成了重试，会掩盖状态丢失');
  ok(/不做透明重启|无透明重启/.test(code), '缺少「不重启」的设计说明');
});

check('code host 崩溃后 dispose 并降级（不静默重建）', () => {
  ok(/codeDegraded/.test(code), '缺少 codeDegraded 降级信号');
  ok(/dispose\(\)/.test(code), '缺少 dispose');
});

check('cua host 透明重启上限恰为 1 次', () => {
  ok(num(cua, 'RESTART_MAX') === 1, `RESTART_MAX=${num(cua, 'RESTART_MAX')}，策略要求 1`);
  ok(/cuaDegraded/.test(cua), '缺少 cuaDegraded 降级信号');
});

check('browser host 只对幂等通道重启（retryable 分支必须存在）', () => {
  ok(num(browser, 'RESTART_MAX') === 1, 'RESTART_MAX 不是 1');
  ok(/retryable/.test(browser), '缺少 retryable 判定——会把 click 这类有副作用的调用也重试');
  ok(/幂等/.test(browser), '缺少幂等通道说明');
});

check('堆上限体现职责差异：code 会话 > cua/browser 包装', () => {
  const mc = num(code, 'MEM_LIMIT_MB');
  const mu = num(cua, 'MEM_LIMIT_MB');
  const mb = num(browser, 'MEM_LIMIT_MB');
  ok(mc > mu && mc > mb, `code=${mc} 应大于 cua=${mu} / browser=${mb}`);
  ok(mu === mb, `cua=${mu} 与 browser=${mb} 同为原生包装，应一致`);
});

check('调用超时体现职责差异：code 最长、cua 最短（osascript 会永久挂起）', () => {
  const tc = num(code, 'CALL_TIMEOUT_MS');
  const tu = num(cua, 'CALL_TIMEOUT_MS');
  const tb = num(browser, 'CALL_TIMEOUT_MS');
  ok(tc > tb && tb > tu, `期望 code(${tc}) > browser(${tb}) > cua(${tu})`);
});

check('三者一律用 argv 传参，不拼 shell 字符串（注入面）', () => {
  for (const [name, src] of [['code', code], ['cua', cua], ['browser', browser]]) {
    ok(!/shell\s*:\s*true/.test(src), `${name} host 打开了 shell:true`);
    ok(/execArgv\s*:/.test(src), `${name} host 未用 execArgv 传参`);
  }
});

check('三者的子进程都用 utilityProcess 而非 child_process（与 Electron 生命周期一致）', () => {
  for (const [name, src] of [['code', code], ['cua', cua], ['browser', browser]]) {
    ok(/utilityProcess/.test(src), `${name} host 未使用 utilityProcess`);
    ok(!/require\(['"]child_process['"]\)/.test(src), `${name} host 直接用了 child_process`);
  }
});

check('三份 host 都声明「utilityProcess 不可用时不假装可用」', () => {
  for (const [name, src] of [['code', code], ['cua', cua], ['browser', browser]]) {
    ok(/isAvailable/.test(src), `${name} host 缺少 isAvailable 能力探测`);
  }
});

console.log(`\n结果：${pass}/${total} 通过`);

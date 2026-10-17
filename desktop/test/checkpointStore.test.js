// 断点持久化测试：save/get/clear 往返 / 覆盖语义 / LRU 淘汰 / 损坏文件 fail-open / 未初始化兜底
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('../main/checkpointStore');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── 未初始化时调用不崩溃（fail-open）──
check('未初始化 get 返回 null', cp.getCheckpoint('t1') === null);
check('未初始化 save 返回 false', cp.saveCheckpoint('t1', { summary: 'x' }) === false);

// ── 正常初始化：save/get/clear 往返 ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-cp-'));
cp.initCheckpointStore(dir);
const data = { summary: '已完成 A，待办 B', usage: { prompt_tokens: 100, completion_tokens: 20 }, rounds: 8, rescues: 3, budget: 100 };
check('save 返回 true', cp.saveCheckpoint('thread-1', data) === true);
const got = cp.getCheckpoint('thread-1');
check('get 取回断点（字段完整 + savedAt 自动盖时间戳）',
  got?.summary === '已完成 A，待办 B' && got?.usage?.prompt_tokens === 100
  && got?.rounds === 8 && typeof got?.savedAt === 'number');

// ── 同 key 覆盖（只留最近一次熔断）──
cp.saveCheckpoint('thread-1', { summary: '第二次熔断', rounds: 12 });
check('同 threadKey 重复保存覆盖', cp.getCheckpoint('thread-1')?.summary === '第二次熔断');

// ── clear ──
check('clear 成功返回 true', cp.clearCheckpoint('thread-1') === true);
check('clear 后 get 返回 null', cp.getCheckpoint('thread-1') === null);
check('clear 不存在的 key 返回 false', cp.clearCheckpoint('nope') === false);

// ── LRU 淘汰：超过 MAX_ENTRIES 后删最早条目 ──
for (let i = 0; i < cp.MAX_ENTRIES; i++) cp.saveCheckpoint(`k${i}`, { summary: `s${i}` });
cp.saveCheckpoint('k-new', { summary: 'newest' });
check('容量满后新 key 可写入', cp.getCheckpoint('k-new')?.summary === 'newest');
check('最早条目被 LRU 淘汰（k0 不在）', cp.getCheckpoint('k0') === null);
check('未淘汰条目仍在（k1）', cp.getCheckpoint('k1')?.summary === 's1');
check('条目总数不超过上限', Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'agent-checkpoints.json'), 'utf8'))).length === cp.MAX_ENTRIES);

// ── 损坏文件 fail-closed：不静默丢弃（P1-15）──
fs.writeFileSync(path.join(dir, 'agent-checkpoints.json'), '{broken json!!', 'utf8');
check('损坏文件 get 返回 null（不抛异常）', cp.getCheckpoint('thread-x') === null);
check('损坏文件留 .corrupt 副本（可恢复，不静默丢弃）',
  fs.readdirSync(dir).some((f) => /^agent-checkpoints\.json\.corrupt-\d+$/.test(f)),
  fs.readdirSync(dir).join(','));
const loadErr = cp.getLoadError();
check('损坏文件错误态可查询（UI/诊断可见）',
  !!loadErr && typeof loadErr.reason === 'string' && loadErr.reason.length > 0
  && !!loadErr.backup && !!loadErr.file && typeof loadErr.at === 'string');
check('损坏文件 save 自动重建', cp.saveCheckpoint('thread-y', { summary: 'after-corruption' }) === true
  && cp.getCheckpoint('thread-y')?.summary === 'after-corruption');
check('恢复成功后错误态清除', cp.getLoadError() === null);

// ── P1-15：原子写（tmp+fsync+rename，无残留 tmp）──
check('原子写：目录内无残留 .tmp 文件',
  !fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), fs.readdirSync(dir).join(','));
check('原子写：文件权限 0600',
  (fs.statSync(path.join(dir, 'agent-checkpoints.json')).mode & 0o777) === 0o600,
  `mode=${(fs.statSync(path.join(dir, 'agent-checkpoints.json')).mode & 0o777).toString(8)}`);

// ── 文件持久化跨实例生效（模拟应用重启）──
delete require.cache[require.resolve('../main/checkpointStore')];
const cp2 = require('../main/checkpointStore');
cp2.initCheckpointStore(dir);
check('重新初始化（模拟重启）后断点仍可读回', cp2.getCheckpoint('thread-y')?.summary === 'after-corruption');

// ── 断点 kind 链路（C5/D1）：超时断点必须能按原因分流恢复文案 ──
// 事故形态：engines 存断点时带 kind，agentRunner 落盘不透传 → 恢复文案把「模型调用超时」
// 说成「token 预算触顶」，用户去调大 token 预算（改错方向）。
const FS = require('fs');
const DESKTOP = path.join(__dirname, '..');
const agentRunnerSrc = FS.readFileSync(path.join(DESKTOP, 'main', 'agentRunner.js'), 'utf8');
const useRunSrc = FS.readFileSync(path.join(DESKTOP, 'renderer', 'src', 'hooks', 'useAgentRun.ts'), 'utf8');

check('saveCheckpoint 保留未声明字段（kind 确实落盘，非仅内存）', (() => {
  cp.saveCheckpoint('thread-kind', { kind: 'timeout', summary: '最后输出', rounds: 7 });
  const fromDisk = JSON.parse(FS.readFileSync(path.join(dir, 'agent-checkpoints.json'), 'utf8'));
  return cp.getCheckpoint('thread-kind')?.kind === 'timeout' && fromDisk['thread-kind']?.kind === 'timeout';
})());
check('agentRunner.onSuspend 透传 kind（缺省 tokens，不改变既有行为）', (() => {
  const fn = agentRunnerSrc.slice(agentRunnerSrc.indexOf('onSuspend: (info) =>'));
  return /kind:\s*info\?\.kind \|\| 'tokens'/.test(fn.slice(0, 600));
})());
check('渲染层恢复分支按 kind 分流（engine-exit / timeout / 预算）', (() => {
  const branches = (useRunSrc.match(/cp\.kind === 'timeout'/g) || []).length;
  return branches === 1
    && /cp\.kind === 'engine-exit'/.test(useRunSrc)
    && /任务中断原因：模型调用超时/.test(useRunSrc)
    && /任务暂停原因：单任务 token 预算触顶/.test(useRunSrc);
})());

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);

// P0-1c：真实进程取消集成测试（门禁条目：禁止仅用 mock 注入 registerChild——
// 既有 test/r5-cancel-run.test.js 的 mock 注入正是让取消回路「测试绿、生产断」的原因）。
//
// 验收口径：
//   1) 真实 spawn 的 shell 子进程经 exec.js 注册进 runId → Set（接线存在，非 mock）；
//   2) detached: true 使子进程自成进程组（POSIX）——killChildrenForRun 用
//      process.kill(-pid, 'SIGTERM') 整组杀灭，孙进程（npm run build 派生类）不留存活；
//   3) 进程 2 秒内真实消失（process.kill(pid, 0) / process.kill(-pid, 0) 探活）；
//   4) 工具结果如实透出 signal=SIGTERM（不把信号终止折叠成成功）。
// macOS / Linux 均可运行；Windows 分支（taskkill /T）同口径镜像，未在 CI 覆盖。
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';

const require = createRequire(import.meta.url);
const Module = require('module');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// electron stub（exec.js 顶层依赖；本测试不经 IPC，直调 toolShell）
const electronStub = {
  app: { getPath: () => '/tmp/mjcode-realproc', on: () => {}, whenReady: () => Promise.resolve() },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: { openPath: async () => '', openExternal: async () => '', showItemInFolder: () => {} },
};
const electronPath = require.resolve('electron');
const stubModule = new Module(electronPath, null);
stubModule.filename = electronPath;
stubModule.loaded = true;
stubModule.exports = electronStub;
require.cache[electronPath] = stubModule;

require('../main/audit/auditLog').initAudit({ getAuthToken: () => null, serverBase: () => 'http://localhost:0' });
const { toolShell, initToolExec } = require('../main/tools/exec');

// ── 模拟 main.js 的 runScope + activeRunChildren（P0-1b 共享闭包工厂的测试侧镜像）──
let currentRunId = null;
const activeRunChildren = new Map(); // runId -> Set<ChildProcess>

// 与 main.js P0-1b diff 中的 killChildrenForRun 同口径（单一事实来源在主进程）
function killChildrenForRun(runId) {
  const set = activeRunChildren.get(runId);
  if (!set) return 0;
  let n = 0;
  for (const c of set) {
    if (!c || !c.pid) continue;
    try {
      if (process.platform === 'win32') {
        // Windows：detached 不构成可杀进程组，用 taskkill /T 杀进程树
        execFile('taskkill', ['/pid', String(c.pid), '/T', '/F'], () => {});
      } else {
        try {
          process.kill(-c.pid, 'SIGTERM'); // detached 子进程自成进程组：整组杀灭（含孙进程）
        } catch (e) {
          if (e.code === 'ESRCH') c.kill('SIGTERM'); // 无独立进程组（未 detached）：回落单进程
          else throw e;
        }
      }
      n += 1;
    } catch (e) {
      // EPERM/ESRCH（已退出/无权限）不炸，继续处理其余子进程
      console.warn(`[cancel] 子进程终止跳过（pid=${c.pid}）：${e.code || e.message}`);
    }
  }
  return n;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// 轮询探活直到进程/进程组消失；返回耗时 ms，超时返回 -1
async function waitGone(probe, id, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!probe(id)) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 50));
  }
  return -1;
}

const DEFAULT_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-realproc-'));
initToolExec({
  requestApproval: async () => 'once',
  applyApprovalDecision: () => {},
  getAlwaysRules: () => [],
  conversationRules: [],
  getDefaultCwd: () => DEFAULT_CWD,
  // 真实注册（非 mock 行为替身）：与 main.js 生产实现同逻辑——按 runId 归集 + close 自清理
  registerChild: (child) => {
    const runId = currentRunId;
    if (!runId || !child || typeof child.kill !== 'function' || !child.pid) return;
    let set = activeRunChildren.get(runId);
    if (!set) { set = new Set(); activeRunChildren.set(runId, set); }
    set.add(child);
    child.once('close', () => {
      set.delete(child);
      if (set.size === 0) activeRunChildren.delete(runId);
    });
  },
});

(async () => {
  // ── 场景 1：单进程——sleep 30 被取消后 2 秒内真实消失 ──
  currentRunId = 'run-realproc-1';
  const p1 = toolShell({ command: 'sleep 30', cwd: DEFAULT_CWD, sandboxPolicy: 'full-access', requireApproval: false });
  // 等子进程 spawn 并完成注册（轮询而非定长 sleep，避免慢机器上假阴性）
  let registered1 = null;
  for (let i = 0; i < 100 && !registered1; i += 1) {
    const set = activeRunChildren.get('run-realproc-1');
    if (set && set.size >= 1) registered1 = [...set][0];
    else await new Promise((r) => setTimeout(r, 20));
  }
  check('场景1: 真实子进程已注册到 runId（接线存在）', !!registered1?.pid, `pid=${registered1?.pid}`);
  check('场景1: 取消前进程真实存活', pidAlive(registered1.pid));
  const killed = killChildrenForRun('run-realproc-1');
  check('场景1: killChildrenForRun 命中已注册子进程', killed >= 1, `killed=${killed}`);
  const res1 = await p1;
  check('场景1: 工具结果如实透出 signal=SIGTERM（不谎报成功）', res1.signal === 'SIGTERM', `signal=${res1.signal}`);
  const goneIn1 = await waitGone(pidAlive, registered1.pid, 2000);
  check('场景1: 进程 2 秒内真实消失（kill(pid,0) 探活）', goneIn1 >= 0, goneIn1 >= 0 ? `${goneIn1}ms` : '仍存活');

  // ── 场景 2：进程组——孙进程（shell 派生的后台命令）随组一并杀灭 ──
  // 这是 P0-1 附带缺陷的回归：此前只 kill 单进程，npm run build 的孙进程全部存活。
  currentRunId = 'run-realproc-2';
  const p2 = toolShell({ command: 'sleep 31 & sleep 32 & wait', cwd: DEFAULT_CWD, sandboxPolicy: 'full-access', requireApproval: false });
  let shPid = null;
  for (let i = 0; i < 100 && !shPid; i += 1) {
    const set = activeRunChildren.get('run-realproc-2');
    if (set && set.size >= 1) shPid = [...set][0].pid;
    else await new Promise((r) => setTimeout(r, 20));
  }
  check('场景2: shell 父进程已注册', !!shPid, `pid=${shPid}`);
  check('场景2: 取消前进程组真实存活', groupAlive(shPid));
  killChildrenForRun('run-realproc-2');
  const res2 = await p2;
  check('场景2: 父进程收到 SIGTERM（signal 透出）', res2.signal === 'SIGTERM', `signal=${res2.signal}`);
  const groupGoneIn = await waitGone(groupAlive, shPid, 2000);
  check('场景2: 整个进程组 2 秒内消失（孙进程不留存活）', groupGoneIn >= 0, groupGoneIn >= 0 ? `${groupGoneIn}ms` : '组内仍有进程');

  // ── 场景 3：已退出的子进程再 kill 不炸（EPERM/ESRCH 容错）──
  currentRunId = 'run-realproc-3';
  const p3 = toolShell({ command: 'echo done', cwd: DEFAULT_CWD, sandboxPolicy: 'full-access', requireApproval: false });
  await p3; // 立即正常退出
  await new Promise((r) => setTimeout(r, 50)); // 等 close 自清理
  let killAfterExit = -1;
  let threw = false;
  try { killAfterExit = killChildrenForRun('run-realproc-3'); } catch { threw = true; }
  check('场景3: 对已退出/已清理的 run 执行 kill 不抛错', threw === false, `killed=${killAfterExit}`);

  fs.rmSync(DEFAULT_CWD, { recursive: true, force: true });
  console.log(`\n──── P0-1 真实进程取消验收汇总：通过 ${pass} · 失败 ${fail} ────`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });

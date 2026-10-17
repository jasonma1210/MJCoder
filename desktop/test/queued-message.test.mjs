// 运行中发消息 = 排队（不打断）—— 2026-10-17 真机回归
//
// 用户实测：「上一个任务还没跑完，我又输入内容，上面那个任务直接断开，下一个开始执行」。
// 期望（对标 WorkBuddy / Codex）：运行中发出的消息**暂存**，卡片上给三个动作
//   ① 直接发（打断当前轮，立刻执行这条）② 修改（回填输入框）③ 删除（丢弃）
//
// 根因：排队机制（queueNext + QueuedTasks 三按钮 + 轮末接力）其实都在，
// 但 Composer 的 Enter 分支走的是 `onSteer`，而 `steer()` 第一行就是 `stop()`。
// 于是"发新消息"= "停掉当前任务"，看起来就是上一个任务被掐断。
//
// 这里守的是接线，不是重写：入队不得停；停止只能由用户显式点①或停止按钮触发。
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

const composer = read('renderer/src/components/Composer.tsx');
const hook = read('renderer/src/hooks/useAgentRun.ts');
const chat = read('renderer/src/components/ChatArea.jsx');

// ── 1. Enter 在运行中必须入队 ──
check('Enter 分支在 loading 时调用入队（onQueue），而不是直接 steer', () => {
  const i = composer.indexOf("e.key === 'Enter' && !e.shiftKey");
  ok(i > 0, '找不到 Enter 分支');
  const seg = composer.slice(i, i + 700);
  ok(/onQueue\s*\|\|\s*onSteer/.test(seg), '未优先使用 onQueue —— 会退回打断当前任务的 steer');
  ok(/put\(input\)/.test(seg), '没有把输入交给入队函数');
  ok(!/if \(loading && onSteer\)\s*\{\s*onSteer\(input\)/.test(seg), '仍存在「loading 就 steer」的旧分支');
});

// ── 2. 入队本身不得停当前任务 ──
check('queueNext 只入队，绝不调用 stop', () => {
  const i = hook.indexOf('function queueNext');
  ok(i > 0, '找不到 queueNext');
  // 切到下一个函数声明为止（固定长度会切进隔壁函数，误判）
  const seg = hook.slice(i, hook.indexOf('\n  function ', i + 10));
  ok(!/stop\(\)/.test(seg), 'queueNext 里出现了 stop() —— 入队会把当前任务打断');
  ok(/setQueued\(/.test(seg), 'queueNext 没有写入队列');
});

check('steer 仍然会停（它的语义就是"打断当前轮"），但只能显式调用', () => {
  const i = hook.indexOf('function steer');
  ok(i > 0, '找不到 steer');
  const seg = hook.slice(i, hook.indexOf('\n  function ', i + 10));
  ok(/stop\(\)/.test(seg), 'steer 不再 stop —— 语义被改了，需要确认');
});

// ── 3. 三个动作都要真的接上 ──
check('排队卡片渲染三个动作按钮（立即执行 / 编辑 / 删除）', () => {
  const i = composer.indexOf('function QueuedTasks');
  ok(i > 0, '找不到 QueuedTasks');
  const seg = composer.slice(i, i + 2200);
  ok(/onRunNow\?\.\(i\)/.test(seg), '缺「立即执行」');
  ok(/onEdit\?\.\(i\)/.test(seg), '缺「编辑」');
  ok(/onRemove\?\.\(i\)/.test(seg), '缺「删除」');
});

check('「立即执行」= 先摘队列、再 stop、再挂起待发（顺序不能反）', () => {
  const i = chat.indexOf('function runQueuedNow');
  ok(i > 0, '找不到 runQueuedNow');
  const seg = chat.slice(i, i + 420);
  const a = seg.indexOf('setQueued');
  const b = seg.indexOf('stop()');
  const c = seg.indexOf('setPendingRun');
  ok(a > 0 && b > a && c > b, `顺序错误：setQueued@${a} stop@${b} setPendingRun@${c}`);
});

check('「编辑」把内容回填输入框，且不覆盖用户已写的内容', () => {
  const i = chat.indexOf('function editQueued');
  ok(i > 0, '找不到 editQueued');
  const seg = chat.slice(i, i + 420);
  ok(/setQueued/.test(seg), '编辑后未从队列摘除');
  ok(/setInput\(/.test(seg), '没有回填输入框');
  ok(/\$\{prev\}|prev\s*\?/.test(seg), '未处理"输入框已有内容"的情况（会吞掉用户正在写的）');
});

check('「删除」只摘队列，不再做别的', () => {
  const i = chat.indexOf('onQueueRemove');
  ok(i > 0, '找不到 onQueueRemove 接线');
  const seg = chat.slice(i, i + 160);
  ok(/filter/.test(seg), '删除没有从队列移除');
  ok(!/stop\(\)/.test(seg), '删除排队项不应停当前任务');
});

// ── 4. 轮末自动接力 ──
check('本轮正常结束后自动发送队首（用户不必再点一次）', () => {
  const i = hook.indexOf('// queue：排队指令在本轮结束后自动接力执行');
  ok(i > 0, '找不到接力逻辑');
  const seg = hook.slice(i, i + 260);
  ok(/q\[0\]/.test(seg), '没有取队首');
  ok(/send\(/.test(seg), '没有接力发送');
});

check('用户主动停止时不接力（排队项保留，避免"点了停止还继续跑"）', () => {
  const i = hook.indexOf('// queue：排队指令在本轮结束后自动接力执行');
  const seg = hook.slice(i, i + 500);
  ok(/onThreadStatus\?\.\('idle'\)/.test(seg), '中止分支没有收敛线程状态');
});

// ── 5. Esc 不能误伤正在跑的任务（2026-10-17 真机：按 Esc 关弹层把任务杀了）──
check('全局 Esc 停止只处理「没人消费」且「焦点不在输入控件」的按键', () => {
  const i = hook.indexOf('Esc 快捷停止生成');
  ok(i > 0, '找不到 Esc 处理');
  const seg = hook.slice(i, hook.indexOf('}, [loading]);', i));
  ok(/e\.defaultPrevented/.test(seg), '未检查按键是否已被组件消费 —— 关弹层会顺带停任务');
  ok(/INPUT|TEXTAREA|isContentEditable/.test(seg), '未排除输入控件 —— 打字时按 Esc 会停任务');
});

check('会消费 Esc 的弹层都声明了 preventDefault（否则冒泡成"停止生成"）', () => {
  const files = ['ContextMenu.jsx', 'ModelSelector.jsx', 'PlusMenu.jsx', 'RightPane.jsx', 'SettingsModal.jsx', 'ThreadList.jsx', 'feedback.jsx'];
  const bad = [];
  for (const f of files) {
    const src = read(`renderer/src/components/${f}`);
    // 该文件里所有 Escape 分支都必须有 preventDefault
    const escLines = src.split('\n').filter((l) => /key === 'Escape'/.test(l));
    const missing = escLines.filter((l) => !/preventDefault/.test(l));
    if (missing.length) bad.push(`${f}: ${missing[0].trim().slice(0, 60)}`);
  }
  ok(bad.length === 0, `以下 Esc 分支未消费按键：\n  ${bad.join('\n  ')}`);
});

console.log(`\n结果：${pass}/${total} 通过`);

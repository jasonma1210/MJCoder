// 定时任务输出归档回归门禁（~/Documents/.MJCoder/tasks/<任务名>/<YYYY-MM-DD>.md）
//
// 为什么需要：定时任务在无人值守下跑完，应用里只有截断到 500 字的 last_result；
// 用户在文件系统里查不到完整产出。归档是「无人值守」的信任基础——出了事能翻当天原文。
// 本文件锁三件事：目录名消毒（防路径穿越）、按天追加（不覆盖历史）、写盘失败不影响任务。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const {
  safeTaskDirName, taskOutputPath, renderRunSection, appendRunRecord, localDate,
} = require(path.join(ROOT, 'main', 'scheduledOutput.js'));

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); fail++; }
}

// ── 目录名消毒 ──
await check('路径穿越被拦住（../ 与分隔符都变成安全字符）', () => {
  for (const evil of ['../../etc/passwd', '..\\..\\windows', 'a/b/c', 'x:y*z?']) {
    const out = safeTaskDirName(evil);
    assert.ok(!out.includes('..'), `仍含 ..：${out}`);
    assert.ok(!out.includes('/') && !out.includes('\\'), `仍含分隔符：${out}`);
    assert.ok(!/[<>:"|?*\u0000-\u001f]/.test(out), `仍含非法字符：${out}`);
  }
});

await check('空名/纯点号回落 untitled，Windows 保留名加后缀', () => {
  assert.equal(safeTaskDirName(''), 'untitled');
  assert.equal(safeTaskDirName('   '), 'untitled');
  assert.equal(safeTaskDirName('..'), 'untitled');
  assert.equal(safeTaskDirName('con'), 'con_task');
  assert.equal(safeTaskDirName('NUL'), 'NUL_task');
});

await check('中文与空格保持可读（只做必要消毒）', () => {
  assert.equal(safeTaskDirName('每日 AI 新闻'), '每日 AI 新闻');
});

await check('路径形状：<base>/.MJCoder/tasks/<任务名>/<日期>.md', () => {
  const p = taskOutputPath('/tmp/base', '每日 AI 新闻', '2026-10-17');
  assert.equal(p, path.join('/tmp/base', '.MJCoder', 'tasks', '每日 AI 新闻', '2026-10-17.md'));
});

// ── 归档写入 ──
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-sched-out-'));
const AT = new Date(2026, 9, 17, 9, 41, 5); // 2026-10-17 09:41:05 本地时间
const runOk = {
  trigger: 'scheduled', status: 'success', duration_ms: 60123,
  output: '1. 某公司发布新模型\n2. 另一条新闻', tools: 5,
  tokens: { prompt_tokens: 46397, completion_tokens: 1200 }, error: '',
};

await check('首写建目录 + 写文件头（任务名 / 日期 / 计划）', async () => {
  const r = await appendRunRecord({ baseDir: base, taskName: '每日 AI 新闻', schedule: '41 9 * * *', run: runOk, at: AT });
  assert.equal(r.ok, true);
  const text = fs.readFileSync(r.file, 'utf8');
  assert.match(text, /^# 每日 AI 新闻 · 2026-10-17/);
  assert.match(text, /- 计划：`41 9 \* \* \*`/);
  assert.match(text, /## 09:41:05 · 成功/);
  assert.match(text, /- 触发：scheduled/);
  assert.match(text, /- 耗时：1m0s/);
  assert.match(text, /46,397 in \/ 1,200 out/);
  assert.match(text, /1\. 某公司发布新模型/, '正文未落盘（用户就是要看这段）');
});

await check('同日第二次运行追加（不覆盖历史、不重复文件头）', async () => {
  const r = await appendRunRecord({
    baseDir: base, taskName: '每日 AI 新闻', schedule: '41 9 * * *',
    run: { ...runOk, output: '第二次的新闻', status: 'success' }, at: new Date(2026, 9, 17, 18, 0, 0),
  });
  const text = fs.readFileSync(r.file, 'utf8');
  assert.equal((text.match(/^# /gm) || []).length, 1, '文件头被重复写入');
  assert.equal((text.match(/^## /gm) || []).length, 2, '两次运行应各有一节');
  assert.ok(text.indexOf('第一次') === -1 && text.includes('1. 某公司发布新模型'), '覆盖了第一次的输出');
  assert.ok(text.includes('第二次的新闻'));
});

await check('失败运行也记录（带失败原因，否则「今天为什么没结果」无从追查）', async () => {
  const r = await appendRunRecord({
    baseDir: base, taskName: '每日 AI 新闻', schedule: '41 9 * * *',
    run: { trigger: 'catchup', status: 'failed', duration_ms: 3000, output: '', error: '模型未调用任何工具且自述无法完成', tools: 0 },
    at: new Date(2026, 9, 17, 19, 0, 0),
  });
  const text = fs.readFileSync(r.file, 'utf8');
  assert.match(text, /## 19:00:00 · 失败/);
  assert.match(text, /失败原因：模型未调用任何工具且自述无法完成/);
});

await check('不同日期落到不同文件', () => {
  const a = taskOutputPath(base, '每日 AI 新闻', '2026-10-17');
  const b = taskOutputPath(base, '每日 AI 新闻', '2026-10-18');
  assert.notEqual(a, b);
  assert.equal(localDate(new Date(2026, 0, 5)), '2026-01-05', '日期必须补零（否则排序会乱）');
});

await check('渲染片段自包含可读（单节可直接贴给别人）', () => {
  const s = renderRunSection(runOk, AT);
  assert.match(s, /^## 09:41:05 · 成功/);
  assert.match(s, /工具调用：5 次/);
  assert.ok(s.endsWith('\n\n'));
});

await check('无文档目录时不抛（归档失败绝不反噬任务结果）', async () => {
  const r = await appendRunRecord({ baseDir: '', taskName: 'x', schedule: '* * * * *', run: runOk, at: AT });
  assert.equal(r.ok, false);
});

fs.rmSync(base, { recursive: true, force: true });
console.log(`\nscheduled-output: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
// 定时任务存储守卫回归（2026-10-18 数据丢失事故）
//
// 事故现场（真机，userData/scheduled-tasks.json）：
//   主文件 31 字节 = {"tasks":[],"runs":[]}，.bak 2851 字节 = 1 个任务 + 2 条运行记录，
//   两者 mtime 相同 → 用户看到「我创建的定时任务不显示了」。
//
// 事故链（已定位）：
//   第二实例启动 → requestSingleInstanceLock 失败 → app.quit() → 顶层注册的 will-quit 照样执行
//   → scheduler.persist() 用模块初始化值 { tasks: [], runs: [] } 写盘。
//   persist() 又「先把旧文件复制成 .bak 再写」，所以磁盘呈现为「空主文件 + 完好备份」，
//   而下一次启动读到的是**合法 JSON 空库** —— 连 loadStore 的损坏告警都不会触发。
//   local-data.json（2.7MB）幸存纯属巧合：localStore.flushSync() 有 _dirty 守卫。
//
// 本测试守四条：
//   ① 未加载完成 → persist() 必须拒绝写盘（不是"尽量少写"，是硬拒绝）
//   ② 损坏主文件 + 好备份 → 自动从 .bak 恢复并回写（而不是以空库开工）
//   ③ 主文件合法但为空 + 备份有货 → 只提示 recoverable，不自动恢复（否则会把"删除最后一条"撤销掉）
//   ④ main.js 的 will-quit 必须被 hasMainLock 闸住（源码断言：这条守卫被删掉时会红）
const { createRequire: createReq } = await import('node:module');
const require = createReq(import.meta.url);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pass = 0;
let total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

// ── electron stub：userData 指向可变目录（STORE_FILE() 每次调用现算，可中途切换）──
let DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-store-guard-'));
const Module = require('module');
const handlers = new Map();
const noop = () => {};
const electronPath = require.resolve('electron');
const stub = new Module(electronPath, null);
stub.filename = electronPath;
stub.loaded = true;
stub.exports = {
  app: { getPath: () => DATA_DIR, whenReady: () => Promise.resolve(), on: noop },
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), once: noop, on: noop },
};
require.cache[electronPath] = stub;

const scheduler = require('../main/scheduler.js');

const storeFile = () => path.join(DATA_DIR, 'scheduled-tasks.json');
const bakFile = () => `${storeFile()}.bak`;
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const GOOD = {
  tasks: [{ id: 't-1', name: '新闻获取', prompt: '获取最新50条AI的新闻', schedule: '10 11 * * *', trigger_type: 'cron', enabled: true }],
  runs: [{ id: 'r-1', task_id: 't-1', status: 'success' }, { id: 'r-2', task_id: 't-1', status: 'failed' }],
};

function resetDir() {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-store-guard-'));
}

(async () => {
  // ── ① 未加载即写盘 = 数据清空。必须发生在任何 loadStore 之前 ──
  await check('未加载存储时 persist() 拒绝写盘：磁盘文件一个字节都不动', () => {
    fs.writeFileSync(storeFile(), JSON.stringify(GOOD, null, 2));
    const before = fs.readFileSync(storeFile(), 'utf8');
    const r = scheduler.persist();
    assert.equal(r.ok, false, 'persist 必须返回失败，而不是静默写盘');
    assert.equal(r.error, 'store_not_loaded');
    assert.equal(fs.readFileSync(storeFile(), 'utf8'), before, '主文件被改写了');
    assert.equal(fs.existsSync(bakFile()), false, '不该动 .bak');
  });

  // ── ② 损坏主文件 + 好备份 → 自动恢复 ──
  await check('主文件损坏且 .bak 完好：自动恢复任务并回写主文件', () => {
    resetDir();
    fs.writeFileSync(storeFile(), '{"tasks": [ {"id": "t-1", "na'); // 半写残留
    fs.writeFileSync(bakFile(), JSON.stringify(GOOD, null, 2));
    scheduler.loadStore();
    const st = scheduler.storeState();
    assert.equal(st.loaded, true);
    assert.equal(st.recoverable.from, 'bak-restored');
    assert.equal(st.recoverable.tasks, 1);
    // 恢复结果必须立刻回写，否则下次启动又要走一遍恢复
    const onDisk = readJson(storeFile());
    assert.equal(onDisk.tasks.length, 1);
    assert.equal(onDisk.tasks[0].name, '新闻获取');
    // 坏文件留证据
    const kept = fs.readdirSync(DATA_DIR).filter((f) => f.includes('.corrupt-'));
    assert.equal(kept.length, 1, '必须保留损坏副本供人工抢救');
  });

  // ── ③ 合法但为空 + 备份有货 → 只提示，不自动恢复 ──
  await check('主文件合法但为空、备份有任务：提示可恢复，不自动恢复', () => {
    resetDir();
    fs.writeFileSync(storeFile(), JSON.stringify({ tasks: [], runs: [] }, null, 2));
    fs.writeFileSync(bakFile(), JSON.stringify(GOOD, null, 2));
    scheduler.loadStore();
    const st = scheduler.storeState();
    assert.equal(st.recoverable.tasks, 1, '应提示备份里有 1 个任务');
    assert.equal(st.recoverable.from, 'bak');
    assert.equal(readJson(storeFile()).tasks.length, 0, '不点头不能自动恢复（会自动撤销用户的删除操作）');
  });

  await check('用户主动删空了任务（cleared_at 标记）：不提示可恢复', () => {
    resetDir();
    fs.writeFileSync(storeFile(), JSON.stringify({ tasks: [], runs: [], cleared_at: '2026-10-18T04:00:00.000Z' }, null, 2));
    fs.writeFileSync(bakFile(), JSON.stringify(GOOD, null, 2));
    scheduler.loadStore();
    assert.equal(scheduler.storeState().recoverable, null, '删完最后一条不该被当成「数据丢失」');
  });

  // ── ④ 一键恢复 ──
  await check('restoreBackup() 把备份写回主文件，并清掉可恢复提示', () => {
    resetDir();
    fs.writeFileSync(storeFile(), JSON.stringify({ tasks: [], runs: [] }, null, 2));
    fs.writeFileSync(bakFile(), JSON.stringify(GOOD, null, 2));
    scheduler.loadStore();
    const r = scheduler.restoreBackup();
    assert.equal(r.ok, true);
    assert.equal(r.tasks, 1);
    assert.equal(r.runs, 2);
    assert.equal(scheduler.storeState().recoverable, null);
    const onDisk = readJson(storeFile());
    assert.equal(onDisk.tasks.length, 1);
    assert.equal(onDisk.runs.length, 2);
    // 覆盖前留了反悔副本
    assert.ok(fs.readdirSync(DATA_DIR).some((f) => f.includes('.before-restore-')), '覆盖前必须留反悔副本');
  });

  await check('restoreBackup() 无备份可用：明确失败，不静默清空', () => {
    resetDir();
    fs.writeFileSync(storeFile(), JSON.stringify({ tasks: [], runs: [] }, null, 2));
    scheduler.loadStore();
    const r = scheduler.restoreBackup();
    assert.equal(r.ok, false);
    assert.match(r.error, /没有可恢复/);
  });

  // ── ⑤ 加载后写盘恢复正态（证明 ① 的守卫没有把正常路径也堵死）──
  await check('加载完成后正常写盘照常工作', () => {
    resetDir();
    scheduler.loadStore();
    const r = scheduler.createTask({ name: '每天新闻', prompt: '获取 20 条 AI 新闻', schedule: '0 9 * * *' });
    assert.equal(r.ok, true);
    const onDisk = readJson(storeFile());
    assert.equal(onDisk.tasks.length, 1);
    assert.equal(onDisk.tasks[0].name, '每天新闻');
  });

  // ── ⑥ 源码断言：will-quit 必须被单实例锁闸住 ──
  // 这条守卫是本次事故的唯一根因修复，被后续重构删掉时没有任何运行时症状能发现它
  await check('main.js：抢锁失败的实例不参与任何退出落盘', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '../main/main.js'), 'utf8');
    assert.match(src, /const hasMainLock = app\.requestSingleInstanceLock\(\)/, '必须把抢锁结果存下来供退出路径判断');
    const quitBlock = src.slice(src.indexOf("app.on('will-quit'"));
    const body = quitBlock.slice(quitBlock.indexOf('{') + 1, quitBlock.indexOf('{') + 200);
    assert.match(body, /if \(!hasMainLock\) return;/, 'will-quit 首行必须直接 return');
    assert.match(src, /scheduler\?\.persist\?\.\(\)/, '退出落盘仍在（不能因为修 bug 把正常落盘一起删掉）');
  });

  scheduler.stopScheduler();
  console.log(`\n[store-guard] ${pass}/${total} 通过`);
  if (pass !== total) process.exitCode = 1;
  process.exit();
})();

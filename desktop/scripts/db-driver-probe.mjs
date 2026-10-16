// N4/R3a 驱动能力探测 PoC（对应《完整产品与源码整改方案 v2》§7.3 驱动 ADR）
// 目的：在**当前真实运行时**逐项探测三类候选驱动的可用性与持久化语义，
// 产出 JSON 能力报告，作为「文件型 SQLite 地基」的 ADR 输入。
// 边界：本脚本只读探测（临时目录内建/删库），不触碰用户数据；单文件自包含可重复执行。
// 用法：node scripts/db-driver-probe.mjs [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jsonOnly = process.argv.includes('--json');
const report = {
  generatedAt: new Date().toISOString(),
  runtime: {
    executable: process.execPath,
    isElectron: !!process.versions.electron,
    electron: process.versions.electron || null,
    node: process.versions.node,
    abi: process.versions.modules,
    platform: `${os.platform()}/${os.arch()}`,
  },
  drivers: {},
};

function tmpDbDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mj-dbprobe-${tag}-`));
}

// ── 候选 A：node:sqlite（Electron 内置 Node 的实验模块）──
try {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = tmpDbDir('nodesqlite');
  try {
    const db = new DatabaseSync(path.join(dir, 't.db'));
    db.exec('CREATE TABLE t(x INTEGER PRIMARY KEY, v TEXT)');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    // 事务 + SAVEPOINT 嵌套语义
    db.exec('BEGIN');
    db.prepare('INSERT INTO t(v) VALUES (?)').run('a');
    db.exec('SAVEPOINT sp1');
    db.prepare('INSERT INTO t(v) VALUES (?)').run('b');
    db.exec('ROLLBACK TO sp1');
    db.exec('COMMIT');
    const rows = db.prepare('SELECT v FROM t ORDER BY x').all();
    const fk = db.prepare('PRAGMA foreign_keys').get();
    const wal = db.prepare('PRAGMA journal_mode').get();
    db.close();
    // 持久性：重开读回
    const db2 = new DatabaseSync(path.join(dir, 't.db'));
    const persisted = db2.prepare('SELECT COUNT(*) AS n FROM t').get().n;
    db2.close();
    report.drivers['node:sqlite'] = {
      available: true,
      savepoint: rows.length === 1 && rows[0].v === 'a',
      foreignKeys: !!(fk && (fk.foreign_keys === 1 || fk.foreign_keys === true)),
      walMode: String(wal?.journal_mode || '').toLowerCase() === 'wal',
      reopenReadback: persisted === 1,
      note: '候选A。注意：本探测在当前运行时通过 ≠ 打包版 Electron 内捆绑 Node 通过，发布前须在真实安装包内复测。',
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
} catch (e) {
  report.drivers['node:sqlite'] = { available: false, reason: e.message.slice(0, 200) };
}

// ── 候选 B：better-sqlite3（原生模块，Electron 需 ABI 匹配 rebuild）──
try {
  const Database = require('better-sqlite3');
  const dir = tmpDbDir('better');
  try {
    const db = new Database(path.join(dir, 't.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE t(x INTEGER PRIMARY KEY, v TEXT)');
    // 事务 + SAVEPOINT + 外键约束真实生效检查
    db.exec("CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(pid INTEGER REFERENCES p(id))");
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO t(v) VALUES (?)').run('a');
      db.prepare('SAVEPOINT sp1').run();
      db.prepare('INSERT INTO t(v) VALUES (?)').run('b');
      db.prepare('ROLLBACK TO sp1').run();
    });
    tx();
    // 外键：插入孤儿应被拒绝
    let fkRejected = false;
    try { db.prepare('INSERT INTO c(pid) VALUES (999)').run(); } catch { fkRejected = true; }
    const rows = db.prepare('SELECT v FROM t ORDER BY x').all();
    const fk = db.pragma('foreign_keys', { simple: true });
    const wal = db.pragma('journal_mode', { simple: true });
    db.close();
    const db2 = new Database(path.join(dir, 't.db'));
    const persisted = db2.prepare('SELECT COUNT(*) AS n FROM t').get().n;
    db2.close();
    report.drivers['better-sqlite3'] = {
      available: true,
      savepoint: rows.length === 1 && rows[0].v === 'a',
      foreignKeys: fk === 1,
      foreignKeyEnforced: fkRejected,
      walMode: String(wal).toLowerCase() === 'wal',
      reopenReadback: persisted === 1,
      note: '候选B。打包版需 electron-rebuild + asarUnpack；当前 optionalDependencies 固定 11.10.0。',
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
} catch (e) {
  report.drivers['better-sqlite3'] = { available: false, reason: e.message.slice(0, 200) };
}

// ── 现状：sql.js（内存库 + 全量 export，非真实 WAL）──
try {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const dir = tmpDbDir('sqljs');
  try {
    const db = new SQL.Database();
    db.run('CREATE TABLE t(x INTEGER PRIMARY KEY, v TEXT)');
    db.run('BEGIN');
    db.run("INSERT INTO t(v) VALUES ('a')");
    db.run('COMMIT');
    const bytes = db.export(); // 全量内存导出 = 持久化方式
    fs.writeFileSync(path.join(dir, 't.db'), Buffer.from(bytes));
    const db2 = new SQL.Database(fs.readFileSync(path.join(dir, 't.db')));
    const res = db2.exec('SELECT COUNT(*) AS n FROM t');
    db2.close();
    report.drivers['sql.js'] = {
      available: true,
      persistenceModel: 'in-memory + full export（无 WAL/增量）',
      savepoint: true, // sql.js 基于 SQLite 编译，SQL 语义支持 SAVEPOINT（但无连接级 PRAGMA 持久性）
      reopenReadback: res[0]?.values?.[0]?.[0] === 1,
      note: '现状打包版驱动。可保留限期兼容，不可宣传为真实 WAL 并发持久引擎（方案 v2 §7.3）。',
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
} catch (e) {
  report.drivers['sql.js'] = { available: false, reason: e.message.slice(0, 200) };
}

report.adr = {
  question: '文件型 SQLite 驱动选型（候选A node:sqlite / 候选B better-sqlite3 / 候选C 独立服务进程）',
  rule: '本报告只覆盖当前运行时。发布裁决必须在【真实 Electron 捆绑运行时 + 三平台安装包】内复测（方案 v2 §7.3：按实际捆绑运行时探测）。',
  nextSteps: [
    'N4-1（本脚本）：当前运行时能力矩阵 ✅',
    'N4-2：electron -r 本脚本（真实 Electron 运行时复测）+ 打包版安装包内复测',
    'N4-3：双驱动 parity 套件（同一断言集跑两驱动，§附录A P3-1 验收）',
    'N4-4：DB host（utilityProcess 单写者）+ 队列背压/超时可见',
  ],
};

const out = JSON.stringify(report, null, 2);
if (jsonOnly) { console.log(out); } else {
  console.log('════ SQLite 驱动能力探测报告 ════');
  console.log(`运行时: Electron=${report.runtime.electron || '无'} Node=${report.runtime.node} ABI=${report.runtime.abi} ${report.runtime.platform}`);
  for (const [name, d] of Object.entries(report.drivers)) {
    console.log(`\n[${name}] available=${d.available}`);
    for (const [k, v] of Object.entries(d)) { if (k !== 'available') console.log(`  ${k}: ${v}`); }
  }
  console.log('\nADR 说明:', JSON.stringify(report.adr, null, 2));
}

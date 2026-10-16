// P1-1/P1-2：SQLite 底座（dev=better-sqlite3 / 打包版=sql.js WASM，双驱动自适应见 openDbAsync）
// 范围裁定（增量演进，不动现有体系）：
//   · 本库只承载【任务编排子系统】（task_groups / sub_tasks），线程/消息/凭证仍走
//     local-data.json（localStore）——两者职责互不重叠，后续按需渐进迁移。
//   · WAL 模式：多 Worker 并发读 + 单写不阻塞；迁移用 PRAGMA user_version 版本链。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { openSqliteJsDb } = require('./sqljsDb');

const MIGRATIONS = [
  {
    version: 1,
    name: 'core-task-tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_groups (
          group_id    TEXT PRIMARY KEY,
          goal        TEXT NOT NULL,
          cwd         TEXT NOT NULL DEFAULT '',
          status      TEXT NOT NULL DEFAULT 'ready',
          dag_json    TEXT,
          result_json TEXT,
          error       TEXT,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sub_tasks (
          task_id     TEXT NOT NULL,
          group_id    TEXT NOT NULL REFERENCES task_groups(group_id),
          seq         INTEGER NOT NULL DEFAULT 0,
          title       TEXT NOT NULL,
          prompt      TEXT NOT NULL,
          depends_on  TEXT NOT NULL DEFAULT '[]',
          critical    INTEGER NOT NULL DEFAULT 0,
          max_retry   INTEGER NOT NULL DEFAULT 0,
          timeout_ms  INTEGER NOT NULL DEFAULT 600000,
          status      TEXT NOT NULL DEFAULT 'pending',
          retry_count INTEGER NOT NULL DEFAULT 0,
          result_json TEXT,
          error       TEXT,
          worker_id   TEXT,
          started_at  INTEGER,
          finished_at INTEGER,
          PRIMARY KEY (group_id, task_id)
        );
        CREATE INDEX IF NOT EXISTS idx_sub_tasks_status ON sub_tasks(status);
        CREATE INDEX IF NOT EXISTS idx_sub_tasks_group ON sub_tasks(group_id);
      `);
    },
  },
  {
    // 自动编排（WorkBuddy 式主理人模式）：auto 组失败/暂停后由主进程自动重规划
    version: 2,
    name: 'task-group-auto-replan',
    up: (db) => {
      db.exec(`
        ALTER TABLE task_groups ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE task_groups ADD COLUMN replan_depth INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE task_groups ADD COLUMN replan_of TEXT;
      `);
    },
  },
  {
    // P2-1/P2-2：记忆体系——五域分层记忆 + 后台任务队列
    // 域（domain）：private / session / global_knowledge / entity / reflection（文档①第五节）
    // 层（tier）：1 原文 / 2 压缩摘要 / 3 长期固化（Tier0 瞬时只在内存，不入库）
    // embedding 暂存 JSON 数组（sqlite-vec 就绪后平移），检索先用词法重叠 + 余弦双路
    version: 3,
    name: 'memory-core-tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id            TEXT PRIMARY KEY,
          space_id      TEXT NOT NULL DEFAULT 'default',
          domain        TEXT NOT NULL DEFAULT 'session',
          tier          INTEGER NOT NULL DEFAULT 1,
          content       TEXT NOT NULL,
          summary       TEXT,
          importance    REAL NOT NULL DEFAULT 0.5,
          entity_tags   TEXT NOT NULL DEFAULT '[]',
          embedding     TEXT,
          expire_at     INTEGER,
          is_valid      INTEGER NOT NULL DEFAULT 1,
          compressed    INTEGER NOT NULL DEFAULT 0,
          re_hit_count  INTEGER NOT NULL DEFAULT 0,
          usage_count   INTEGER NOT NULL DEFAULT 0,
          source        TEXT,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memories_space ON memories(space_id, domain, tier);
        CREATE INDEX IF NOT EXISTS idx_memories_valid ON memories(is_valid, expire_at);
        CREATE TABLE IF NOT EXISTS memory_bg_tasks (
          id          TEXT PRIMARY KEY,
          type        TEXT NOT NULL,
          payload     TEXT,
          priority    INTEGER NOT NULL DEFAULT 3,
          status      TEXT NOT NULL DEFAULT 'queued',
          attempts    INTEGER NOT NULL DEFAULT 0,
          error       TEXT,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_bg_tasks_status ON memory_bg_tasks(status, priority);
      `);
    },
  },
  {
    // V04（2026-10-16）：治理快照固化到组——子任务权限继承「建组时刻」的父上下文快照，
    // 不再读取全局最近一次会话设置（父子任务权限只可收紧，且建组后不受后续会话变更影响）。
    version: 4,
    name: 'task-group-policy-snapshot',
    up: (db) => {
      db.exec(`
        ALTER TABLE task_groups ADD COLUMN approval_mode TEXT;
        ALTER TABLE task_groups ADD COLUMN sandbox_policy TEXT;
      `);
    },
  },
  {
    // N5（2026-10-16）：副作用账本——V14「重启不自动重放」的可审计地基。
    // Worker 领取任务即记 uncertain（该任务可能产生副作用），终态时 resolved；
    // 重启恢复时 uncertain 记录原样保留 = 「副作用无法确认」的清单，随 needsReview 供人工核对。
    // 一组一任务一行（upsert），重试重新领取会回到 uncertain。
    version: 5,
    name: 'side-effects-ledger',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS side_effects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'uncertain',
          created_at INTEGER NOT NULL,
          resolved_at INTEGER,
          UNIQUE(group_id, task_id)
        );
        CREATE INDEX IF NOT EXISTS idx_side_effects_state ON side_effects(state);
      `);
    },
  },
  {
    // R6（2026-10-16，用户实测反馈）：任务组绑定创建它的会话——
    // 此前组在所有工作区/会话的任务面板都显示（默认工作区也能看到别的仓库的组）。
    // thread_id = 创建组的会话 id；历史组无该列 → 渲染层按 cwd 归属显示。
    version: 6,
    name: 'task-group-thread-binding',
    up: (db) => {
      db.exec('ALTER TABLE task_groups ADD COLUMN thread_id TEXT;');
    },
  },
];

function openDb(dataDir) {
  // better-sqlite3 惰性 require：打包环境未 rebuild 时给出可行动错误而非进程崩溃
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (e) {
    throw new Error(`better-sqlite3 加载失败（${e.message}）。打包版需确认 electron-builder asarUnpack 与 electron-rebuild 配置。`);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'mjcode-tasks.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

// ── 驱动选择（openDbAsync）──
// better-sqlite3 是原生模块，在部分受限环境（如本沙箱）的 Electron 内 new Database() 会
// SIGSEGV 且不可捕获。策略：
//   1. MJ_DB_DRIVER=sqljs / better-sqlite3 → 强制指定
//   2. auto（默认）+ packaged：**直接 sql.js，不加载任何原生模块**——
//      真机事故（2026-10-14）：打包版 DMG 主进程启动 7s 即 SIGSEGV，栈在 node_module_register/
//      napi_register_module_v1，崩溃前 better-sqlite3 prebuild 已加载且金丝雀探测已放行
//      （探测子进程环境干净，复现不了完整主进程状态下的 NAPI 注册崩溃）。
//      结论：主进程内的原生模块加载无法用子进程探测兜底 → 打包版一律 sql.js（WASM，零原生依赖）。
//   3. auto + 非 packaged（dev）：子进程「金丝雀」探测；通过 → better-sqlite3（开发期更快），
//      失败/超时 → 降级 sql.js。
//      （探测为一次性子进程成本 ~1s，换取「永不因驱动崩溃而失能任务编排子系统」）
const PROBE_SRC = `
try {
  if (process.platform === 'darwin') { try { require('electron').app.dock.hide(); } catch {} }
  const Database = require(process.env.MJ_PROBE_MODULE);
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t(x)');
  db.prepare('INSERT INTO t VALUES (?)').run(1);
  if (db.prepare('SELECT x FROM t').get().x !== 1) process.exit(3);
  db.close();
  process.exit(0);
} catch (e) { process.exit(2); }
`;

function probeBetterSqlite3(timeoutMs = 10000) {
  return new Promise((resolve) => {
    const probeFile = path.join(os.tmpdir(), `mj-sqlite-probe-${process.pid}.js`);
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { fs.unlinkSync(probeFile); } catch { /* 临时文件清理尽力而为 */ }
      resolve(ok);
    };
    try {
      let modulePath;
      try { modulePath = require.resolve('better-sqlite3'); } catch { return done(false); }
      fs.writeFileSync(probeFile, PROBE_SRC);
      const env = { ...process.env, MJ_PROBE_MODULE: modulePath, ELECTRON_DISABLE_SANDBOX: '1' };
      delete env.ELECTRON_RUN_AS_NODE; // 必须以真实 Electron 运行时探测（Node 模式复现不了 SIGSEGV）
      const child = spawn(process.execPath, ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', probeFile], {
        env, stdio: 'ignore', detached: false,
      });
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } done(false); }, timeoutMs);
      child.on('close', (code, signal) => { clearTimeout(timer); done(code === 0 && !signal); });
      child.on('error', () => { clearTimeout(timer); done(false); });
    } catch {
      done(false);
    }
  });
}

async function openDbAsync(dataDir, { isPackaged = false, driver: driverOverride } = {}) {
  const file = path.join(dataDir, 'mjcode-tasks.db');
  fs.mkdirSync(dataDir, { recursive: true });
  // driverOverride 显式指定驱动（测试用 'sqljs' 强制零原生，绕过 better-sqlite3 ABI/编译依赖）；
  // 未指定则按环境变量 MJ_DB_DRIVER 走，缺省 auto。
  const driver = String(driverOverride || process.env.MJ_DB_DRIVER || 'auto').toLowerCase();

  if (driver === 'sqljs') {
    const db = await openSqliteJsDb(file);
    migrate(db);
    return db;
  }

  // 打包版：auto 直接 sql.js（见上方事故注释——原生模块崩溃无法用子进程探测兜底）
  if (driver === 'auto' && isPackaged) {
    const db = await openSqliteJsDb(file);
    migrate(db);
    console.log('[db] SQLite 驱动：sql.js（WASM，打包版固定）');
    return db;
  }

  // dev（auto）：金丝雀探测——SIGSEGV 只杀子进程，主进程据此安全降级
  if (driver === 'better-sqlite3' || (driver === 'auto' && (await probeBetterSqlite3()))) {
    try {
      const db = openDb(dataDir);
      console.log('[db] SQLite 驱动：better-sqlite3（原生，dev）');
      return db;
    } catch (e) {
      if (driver === 'better-sqlite3') throw e;
      console.warn(`[db] better-sqlite3 不可用（${e.message}），降级 sql.js`);
    }
  } else {
    console.log('[db] 金丝雀探测失败：better-sqlite3 在当前 Electron 环境不安全，降级 sql.js（WASM）');
  }

  const db = await openSqliteJsDb(file);
  migrate(db);
  console.log('[db] SQLite 驱动：sql.js（WASM 降级）');
  return db;
}

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const tx = db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    });
    tx();
    console.log(`[db] 迁移 v${m.version} 完成：${m.name}`);
  }
}

module.exports = { openDb, openDbAsync, MIGRATIONS };

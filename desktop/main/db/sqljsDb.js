// P1 降级驱动：sql.js（SQLite 编译为 WASM，零原生模块）的 better-sqlite3 兼容适配层
// 背景：better-sqlite3（原生 .node）在本沙箱环境的 Electron 内 SIGSEGV（v11/v13 均复现，
//       崩溃点在 new Database()，且 SIGSEGV 不可捕获）。按调整计划既定降级方案落地本适配层。
// 覆盖 API 面（仅 db/index.js 与 taskStore.js 实际用到的子集）：
//   db.exec(sql)                        多语句 DDL/PRAGMA
//   db.prepare(sql).run/get/all(...p)   参数绑定查询（undefined → null 归一）
//   db.pragma(src[, {simple:true}])     读/写 PRAGMA（WAL 在内存库上无害降级）
//   db.transaction(fn)                  BEGIN/COMMIT/ROLLBACK 包装
//   db.flush() / db.close()             持久化：写入防抖 150ms 导出落盘 + 退出强刷
const fs = require('fs');
const path = require('path');
const { writeFileDurable } = require('../data/durableWrite');

const PERSIST_DEBOUNCE_MS = 150;

async function openSqliteJsDb(filePath) {
  const initSqlJs = require('sql.js');
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });

  // 载入既有库文件（断点续跑：重启后恢复全部状态）
  let sqldb;
  if (fs.existsSync(filePath)) {
    try {
      sqldb = new SQL.Database(fs.readFileSync(filePath));
    } catch (e) {
      console.error(`[db] 既有库文件损坏，重建：${e.message}`);
      sqldb = new SQL.Database();
    }
  } else {
    sqldb = new SQL.Database();
  }

  let dirty = false;
  let timer = null;

  function flush() {
    if (!dirty) return;
    try {
      const data = Buffer.from(sqldb.export());
      // P0-持久化（2026-10-16）：原实现 writeFileSync(tmp)+renameSync 无 fsync，
      // 数据可能停留在 page cache。改走 writeFileDurable（fsync 文件 + fsync 目录）。
      const res = writeFileDurable(filePath, data);
      if (!res.ok) {
        // dirty 保持 true：下次 flush 会重试。若在此清 dirty，这次变更就永久丢了。
        console.error('[db] sql.js 落盘失败:', res.error);
        return;
      }
      dirty = false;
    } catch (e) {
      console.error('[db] sql.js 落盘异常:', e.message);
    }
  }

  function schedulePersist() {
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, PERSIST_DEBOUNCE_MS);
  }

  // 一次性注册 exit 兜底：防抖窗口内进程退出也不丢数据（flush 幂等）
  process.on('exit', () => { try { flush(); } catch { /* 退出期尽力而为 */ } });

  function norm(params) {
    return (params || []).map((p) => (p === undefined ? null : p));
  }

  const db = {
    // 标识符：main.js will-quit 判断是否需要 flush
    __driver: 'sqljs',

    exec(sql) {
      sqldb.exec(sql);
      schedulePersist();
    },

    prepare(sql) {
      return {
        run(...params) {
          sqldb.run(sql, norm(params));
          const changes = sqldb.getRowsModified();
          schedulePersist();
          return { changes };
        },
        get(...params) {
          const stmt = sqldb.prepare(sql);
          try {
            stmt.bind(norm(params));
            return stmt.step() ? stmt.getAsObject() : undefined;
          } finally {
            stmt.free();
          }
        },
        all(...params) {
          const stmt = sqldb.prepare(sql);
          const rows = [];
          try {
            stmt.bind(norm(params));
            while (stmt.step()) rows.push(stmt.getAsObject());
          } finally {
            stmt.free();
          }
          return rows;
        },
      };
    },

    pragma(source, opts = {}) {
      const isSet = /[=]/.test(source);
      if (!isSet) {
        const res = sqldb.exec(`PRAGMA ${source}`);
        const v = res[0]?.values?.[0]?.[0];
        return opts.simple ? v : v;
      }
      // 写式 PRAGMA：WAL/foreign_keys 在内存实现上无害降级，user_version 真实生效
      sqldb.run(`PRAGMA ${source}`);
      schedulePersist();
      return undefined;
    },

    transaction(fn) {
      return (...args) => {
        sqldb.run('BEGIN');
        try {
          const out = fn(...args);
          sqldb.run('COMMIT');
          schedulePersist();
          return out;
        } catch (e) {
          try { sqldb.run('ROLLBACK'); } catch { /* 已回滚/连接异常 */ }
          throw e;
        }
      };
    },

    flush,
    close() {
      if (timer) clearTimeout(timer);
      flush();
      try { sqldb.close(); } catch { /* 幂等 */ }
    },
  };

  return db;
}

module.exports = { openSqliteJsDb, PERSIST_DEBOUNCE_MS };

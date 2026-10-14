// 诊断探针：在真实 Electron 主进程中验证 better-sqlite3 可用性
try {
  const Database = require('better-sqlite3');
  console.log('[probe] better-sqlite3 require OK, version:', new Database(':memory:').prepare('select sqlite_version() v').get().v);
  const db = new Database('/tmp/mjcode-probe.db');
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS t(a INTEGER)');
  db.prepare('INSERT INTO t VALUES (?)').run(1);
  console.log('[probe] read/write OK:', db.prepare('SELECT count(*) n FROM t').get().n);
  db.close();
  console.log('[probe] ALL OK');
} catch (e) {
  console.error('[probe] FAILED:', e.message);
}
process.exit(0);

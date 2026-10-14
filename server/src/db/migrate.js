const db = require('./index');

// ── P1-2 修复：PostgreSQL 不支持 `ADD COLUMN IF NOT EXISTS` ──
// 事故背景：本文件原先全部写成 `ALTER TABLE x ADD COLUMN IF NOT EXISTS y ...`。
// 该语法是 SQLite / MySQL 的方言，**PostgreSQL 并不支持**——在 PG 上首次执行
// 迁移就会抛 syntax error，而 db/init.js 对该异常执行 process.exit(1)，
// 结果是「重复启动即崩溃」：库可能已建好一半，但迁移永远报错，服务起不来。
// 且它「看起来幂等」实则完全不可执行，是最危险的一类假幂等。
//
// 正解：先查 information_schema.columns 判断列是否已存在，再决定是否 ALTER。
// 这样既保持「可重复执行」的幂等语义，又是 PG 原生支持的写法。
async function addColumnIfMissing(table, column, definition) {
  const exists = await db.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  if (exists && exists.rows && exists.rows.length > 0) return false; // 已存在，跳过
  await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

// 增量迁移：每个 migration 幂等（列存在性检查 / CREATE IF NOT EXISTS），执行记录落 schema_migrations
const MIGRATIONS = [
  {
    id: '001_role_and_thread_columns',
    up: async () => {
      await addColumnIfMissing('users', 'role', `VARCHAR(20) DEFAULT 'user'`);
      await addColumnIfMissing('threads', 'sandbox_policy', `VARCHAR(30) DEFAULT 'workspace-write'`);
      await addColumnIfMissing('threads', 'approval_mode', `VARCHAR(30) DEFAULT 'on-request'`);
      await addColumnIfMissing('threads', 'git_branch', `VARCHAR(255)`);
      await addColumnIfMissing('threads', 'git_sha', `VARCHAR(64)`);
    },
  },
  {
    id: '002_scheduled_task_runs',
    up: async () => {
      await addColumnIfMissing('scheduled_tasks', 'last_status', `VARCHAR(20)`);
      await addColumnIfMissing('scheduled_tasks', 'last_result', `TEXT`);
      await db.query(`CREATE TABLE IF NOT EXISTS scheduled_task_runs (
        id SERIAL PRIMARY KEY,
        task_id INTEGER REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
        status VARCHAR(20) DEFAULT 'running',
        output TEXT,
        error TEXT,
        started_at TIMESTAMP DEFAULT NOW(),
        finished_at TIMESTAMP
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_task_runs_task ON scheduled_task_runs(task_id)`);
    },
  },
  {
    id: '003_audit_logs',
    up: async () => {
      await db.query(`CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        action VARCHAR(100) NOT NULL,
        target TEXT,
        detail TEXT,
        approval_result VARCHAR(30),
        created_at TIMESTAMP DEFAULT NOW()
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at)`);
    },
  },
  {
    id: '004_cloud_tasks',
    up: async () => {
      // 云端委派：任务侧标记执行模式与容器镜像
      await addColumnIfMissing('scheduled_tasks', 'execution_mode', `VARCHAR(20) DEFAULT 'local'`);
      await addColumnIfMissing('scheduled_tasks', 'container_image', `TEXT`);
      // 云端运行侧：细粒度状态机 + 沙箱标识 + diff 链接 + 结构化报告
      await addColumnIfMissing('scheduled_task_runs', 'state', `VARCHAR(20)`);
      await addColumnIfMissing('scheduled_task_runs', 'sandbox_id', `TEXT`);
      await addColumnIfMissing('scheduled_task_runs', 'diff_url', `TEXT`);
      await addColumnIfMissing('scheduled_task_runs', 'report', `JSONB`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_task_runs_state ON scheduled_task_runs(state)`);
    },
  },
  {
    id: '005_collab_docs',
    up: async () => {
      // 协同 CRDT 文档：每个业务实体一行，存最新快照与已推进的 seq
      await db.query(`CREATE TABLE IF NOT EXISTS collab_docs (
        id SERIAL PRIMARY KEY,
        doc_id VARCHAR(200) NOT NULL UNIQUE,
        doc_type VARCHAR(30) NOT NULL,
        owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        last_seq BIGINT NOT NULL DEFAULT 0,
        snapshot BYTEA,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`);
      // update 追加日志：快照之后的增量，供离线端按 stateVector 补齐与崩溃恢复
      await db.query(`CREATE TABLE IF NOT EXISTS collab_doc_updates (
        id BIGSERIAL PRIMARY KEY,
        doc_id VARCHAR(200) NOT NULL REFERENCES collab_docs(doc_id) ON DELETE CASCADE,
        seq BIGINT NOT NULL,
        update_blob BYTEA NOT NULL,
        actor VARCHAR(120),
        created_at TIMESTAMP DEFAULT NOW()
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_collab_updates_doc_seq ON collab_doc_updates(doc_id, seq)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_collab_docs_type ON collab_docs(doc_type)`);
      // 团队空间成员（看板/审批共享范围与在线成员展示）
      await db.query(`CREATE TABLE IF NOT EXISTS collab_space_members (
        id SERIAL PRIMARY KEY,
        space_id VARCHAR(200) NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(20) DEFAULT 'member',
        display_name VARCHAR(80),
        last_seen_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (space_id, user_id)
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_collab_space_members_space ON collab_space_members(space_id)`);
    },
  },
];

async function runMigrations() {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id VARCHAR(100) PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT NOW()
  )`);
  const applied = await db.query('SELECT id FROM schema_migrations');
  const done = new Set(applied.rows.map(r => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await m.up();
    await db.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
    console.log(`[migrate] ${m.id} 已应用`);
  }
}

module.exports = { runMigrations, MIGRATIONS };

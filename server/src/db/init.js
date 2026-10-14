const fs = require('fs');
const path = require('path');
const db = require('./index');
const { runMigrations } = require('./migrate');

// 新库初始化：按依赖顺序执行全部 schema 文件
const SCHEMA_FILES = ['schema.sql', 'schema_global.sql', 'schema_extra.sql'];

async function init() {
  for (const file of SCHEMA_FILES) {
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
    try {
      await db.query(sql);
      console.log(`[init] ${file} 执行成功`);
    } catch (err) {
      console.error(`[init] ${file} 执行失败:`, err.message);
      process.exit(1);
    }
  }
  // 存量库增量迁移（幂等）
  try {
    await runMigrations();
    console.log('[init] 增量迁移完成');
  } catch (err) {
    console.error('[init] 迁移失败:', err.message);
    process.exit(1);
  }
  process.exit(0);
}

init();

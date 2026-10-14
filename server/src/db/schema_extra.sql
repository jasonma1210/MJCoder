-- 定时任务表
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  prompt TEXT NOT NULL,
  schedule VARCHAR(100) NOT NULL,
  thread_id INTEGER REFERENCES threads(id) ON DELETE SET NULL,
  enabled BOOLEAN DEFAULT true,
  last_run_at TIMESTAMP,
  next_run_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 子代理表
CREATE TABLE IF NOT EXISTS subagents (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  parent_thread_id INTEGER REFERENCES threads(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  objective TEXT NOT NULL,
  status VARCHAR(50) DEFAULT 'active',
  token_budget INTEGER DEFAULT 100000,
  tokens_used INTEGER DEFAULT 0,
  result TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 插件表
CREATE TABLE IF NOT EXISTS plugins (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) DEFAULT 'builtin',
  config JSONB DEFAULT '{}',
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

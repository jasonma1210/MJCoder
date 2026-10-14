-- MJ Code Database Schema

-- Users
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  avatar_url TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Model Providers (user-configured API endpoints)
CREATE TABLE IF NOT EXISTS model_providers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,           -- e.g. "DeepSeek", "Qwen"
  provider_type VARCHAR(50) DEFAULT 'openai', -- openai-compatible
  base_url TEXT NOT NULL,                -- e.g. https://api.deepseek.com/v1
  api_key TEXT NOT NULL,                 -- encrypted at rest (simple XOR for now)
  wire_api VARCHAR(20) DEFAULT 'chat',   -- chat | responses
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, name)
);

-- Models available per provider
CREATE TABLE IF NOT EXISTS models (
  id SERIAL PRIMARY KEY,
  provider_id INTEGER REFERENCES model_providers(id) ON DELETE CASCADE,
  model_id VARCHAR(255) NOT NULL,        -- e.g. "deepseek-chat", "qwen-plus"
  display_name VARCHAR(255),
  context_window INTEGER DEFAULT 128000,
  max_output INTEGER DEFAULT 4096,
  supports_streaming BOOLEAN DEFAULT true,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(provider_id, model_id)
);

-- Threads (chat sessions)
CREATE TABLE IF NOT EXISTS threads (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(500),
  cwd TEXT,                              -- working directory / project path
  model_id INTEGER REFERENCES models(id),
  provider_id INTEGER REFERENCES model_providers(id),
  provider_name VARCHAR(100),            -- snapshot for display
  model_name VARCHAR(255),               -- snapshot for display
  sandbox_policy VARCHAR(30) DEFAULT 'workspace-write',  -- read-only | workspace-write | full-access
  approval_mode VARCHAR(30) DEFAULT 'on-request',        -- on-request | auto-safe | always | never
  git_branch VARCHAR(255),
  git_sha VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  archived BOOLEAN DEFAULT false
);

-- Messages within a thread
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  thread_id INTEGER REFERENCES threads(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL,             -- user | assistant | system | tool
  content TEXT NOT NULL,
  tool_calls JSONB,
  tool_call_id VARCHAR(255),
  tokens_input INTEGER DEFAULT 0,
  tokens_output INTEGER DEFAULT 0,
  model_name VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);

-- User preferences (theme, settings)
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme VARCHAR(50) DEFAULT 'dark',
  custom_colors JSONB,                   -- { primary, background, sidebar, accent }
  default_model_id INTEGER,
  sidebar_collapsed BOOLEAN DEFAULT false,
  font_size INTEGER DEFAULT 14,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_threads_user ON threads(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_providers_user ON model_providers(user_id);
CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id);

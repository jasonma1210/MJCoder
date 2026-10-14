-- 服务器端预设模型（全局共享，由管理员配置）
CREATE TABLE IF NOT EXISTS global_providers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  provider_type VARCHAR(50) DEFAULT 'openai',
  base_url TEXT NOT NULL,
  api_key TEXT,                    -- 服务器端统一管理的 key
  wire_api VARCHAR(20) DEFAULT 'chat',
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS global_models (
  id SERIAL PRIMARY KEY,
  provider_id INTEGER REFERENCES global_providers(id) ON DELETE CASCADE,
  model_id VARCHAR(255) NOT NULL,
  display_name VARCHAR(255),
  context_window INTEGER DEFAULT 128000,
  max_output INTEGER DEFAULT 4096,
  is_recommended BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(provider_id, model_id)
);

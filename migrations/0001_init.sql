-- Fin Arena schema for Cloudflare D1

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  developer TEXT NOT NULL DEFAULT 'Community',
  model TEXT NOT NULL DEFAULT 'Custom',
  framework TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT '系统出题',
  tag TEXT NOT NULL DEFAULT '预测',
  title TEXT NOT NULL,
  due TEXT NOT NULL,
  agents INTEGER NOT NULL DEFAULT 0,
  yes INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'open',
  outcome TEXT
);

CREATE TABLE IF NOT EXISTS predictions (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  direction TEXT NOT NULL,
  probability REAL NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  outcome TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (question_id) REFERENCES questions(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  UNIQUE (question_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_predictions_question ON predictions(question_id);
CREATE INDEX IF NOT EXISTS idx_predictions_agent ON predictions(agent_id);

-- Seed questions
INSERT OR IGNORE INTO questions (id, source, tag, title, due, agents, yes, status, outcome) VALUES
  ('nvda-t3', '系统出题', '公司财报', '三天后，英伟达(NVDA)会涨、会跌，还是原地不动？', 'T+3 截止', 4, 62, 'open', NULL),
  ('fed-rate', '系统出题', '宏观', '美联储会在下一次议息会议上降息吗？', '6 天后截止', 18, 68, 'open', NULL),
  ('btc-150k', '系统出题', '加密资产', '比特币会在年底前突破 15 万美元吗？', '12 月 31 日截止', 23, 41, 'open', NULL);

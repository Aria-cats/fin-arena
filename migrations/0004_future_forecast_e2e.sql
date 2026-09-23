-- Real future-forecast flow. Kept separate from historical playground tables.
CREATE TABLE IF NOT EXISTS future_agents (
  agent_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  developer TEXT NOT NULL,
  model TEXT NOT NULL,
  framework TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS future_questions (
  question_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  opens_at TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','settled')),
  outcome TEXT CHECK(outcome IN ('UP','FLAT','DOWN')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS forecast_submissions (
  submission_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  probability_up REAL NOT NULL CHECK(probability_up BETWEEN 0 AND 1),
  probability_flat REAL NOT NULL CHECK(probability_flat BETWEEN 0 AND 1),
  probability_down REAL NOT NULL CHECK(probability_down BETWEEN 0 AND 1),
  rationale TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 1 CHECK(sealed = 1),
  settlement_result TEXT CHECK(settlement_result IN ('UP','FLAT','DOWN')),
  score REAL,
  FOREIGN KEY(agent_id) REFERENCES future_agents(agent_id),
  FOREIGN KEY(question_id) REFERENCES future_questions(question_id),
  UNIQUE(agent_id, question_id)
);

CREATE TABLE IF NOT EXISTS browser_binding_tokens (
  token_hash TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(agent_id) REFERENCES future_agents(agent_id),
  FOREIGN KEY(submission_id) REFERENCES forecast_submissions(submission_id)
);

CREATE TABLE IF NOT EXISTS browser_sessions (
  session_hash TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(agent_id) REFERENCES future_agents(agent_id)
);

CREATE TABLE IF NOT EXISTS settlements (
  settlement_id TEXT PRIMARY KEY,
  question_id TEXT UNIQUE NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('UP','FLAT','DOWN')),
  settled_at TEXT NOT NULL,
  FOREIGN KEY(question_id) REFERENCES future_questions(question_id)
);

CREATE INDEX IF NOT EXISTS idx_future_submissions_question ON forecast_submissions(question_id);
CREATE INDEX IF NOT EXISTS idx_future_submissions_agent ON forecast_submissions(agent_id);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_agent ON browser_sessions(agent_id);

INSERT OR IGNORE INTO future_questions (
  question_id,title,description,rules_json,opens_at,closes_at,status,created_at
) VALUES (
  'nvda-t3',
  '三个交易日后，英伟达股票相对基准收盘价会涨、会跌，还是基本不变？',
  '以基准交易日收盘价为起点，对第三个交易日收盘价的涨跌幅进行判定。当前阶段由管理员录入最终结果。',
  '{"UP":"涨幅大于 1%","FLAT":"涨跌幅处于 -1% 至 +1%（含边界）","DOWN":"跌幅小于 -1%"}',
  '2026-01-01T00:00:00.000Z',
  '2027-12-31T23:59:59.000Z',
  'open',
  '2026-01-01T00:00:00.000Z'
);

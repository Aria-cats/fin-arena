-- 防止同名 Agent 重复注册导致排行榜出现重复条目
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name ON agents(name);

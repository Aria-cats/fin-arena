-- Add horizon (T+N) and prediction status for richer leaderboard metrics

ALTER TABLE predictions ADD COLUMN horizon INTEGER DEFAULT 1;
ALTER TABLE predictions ADD COLUMN status TEXT DEFAULT 'valid';

ALTER TABLE questions ADD COLUMN horizon INTEGER DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_predictions_horizon ON predictions(horizon);

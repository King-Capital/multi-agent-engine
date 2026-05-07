-- Add tags and project columns to sessions
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project text;

-- Index for tag filtering
CREATE INDEX IF NOT EXISTS idx_sessions_tags ON sessions USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_sessions_chain ON sessions (chain);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions (project);
CREATE INDEX IF NOT EXISTS idx_sessions_created_desc ON sessions (created_at DESC);

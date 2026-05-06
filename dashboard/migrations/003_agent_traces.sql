CREATE TABLE agent_traces (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('input', 'output')),
  content TEXT NOT NULL,
  content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_traces_session ON agent_traces(session_id);
CREATE INDEX idx_traces_agent ON agent_traces(agent_id);
CREATE INDEX idx_traces_direction ON agent_traces(direction);
CREATE INDEX idx_traces_tsv ON agent_traces USING GIN(content_tsv);
CREATE INDEX idx_traces_created ON agent_traces(created_at);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  uid INTEGER NOT NULL,
  gid INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',  -- admin, user, agent
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER REFERENCES users(id),
  name TEXT NOT NULL,                  -- logical name like "MAE dogfood run #3"
  platform TEXT NOT NULL DEFAULT 'multi-agent-engine',  -- pi, pi-tools, multi-agent-engine
  team TEXT,                           -- team name from YAML config
  chain TEXT,                          -- chain name if applicable
  status TEXT NOT NULL DEFAULT 'active',  -- active, completed, failed, cancelled
  config JSONB,                        -- full team/chain config snapshot
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE agents (
  id SERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,              -- internal engine agent ID
  role TEXT NOT NULL,                  -- orchestrator, lead, worker
  persona TEXT,                        -- skippy, bilby, etc.
  adapter TEXT,                        -- claude-code, codex, pi, echo
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed
  prompt TEXT,                         -- the prompt given to this agent
  config JSONB,                        -- agent config (editable from dashboard)
  result JSONB,                        -- output/result
  cost_usd DECIMAL(10,4) DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id TEXT,
  event_type TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_agents_session ON agents(session_id);
CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_events_session ON events(session_id);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_created ON events(created_at);

-- Seed users (UIDs from homelab-users.conf)
INSERT INTO users (username, display_name, uid, gid, role) VALUES
('rico', 'Rico', 3000, 3000, 'admin'),
('kevin', 'Kevin', 3001, 3001, 'user'),
('lisa', 'Lisa', 3005, 3001, 'user'),
('geetesh', 'Geetesh', 3002, 3001, 'user'),
('skippy', 'Skippy', 3004, 3001, 'agent'),
('bilby', 'Bilby', 3006, 3001, 'agent');

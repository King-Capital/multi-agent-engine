# MAE Roadmap — From Prototype to Pro Harness

**Created:** 2026-05-05
**Status:** Active development, dashboard deployed, PR #3 open

## Current State (v0.1)

Working: YAML-configured teams/chains, Pi/A2A/echo adapters, PG persistence,
user scoping (6 users), dashboard API + basic UI, `mae` CLI installed globally, LXC deployed
at your-domain.example.com, 54 tests passing.

## Phase 1 — Live Observability

**Goal:** Real-time dashboard that shows what agents are doing as they do it.

- [ ] WebSocket/SSE push from Go dashboard to frontend (replace polling)
- [ ] Event stream timeline with success/failure icons per tool call
- [ ] Agent session filters as colored pills (click to isolate)
- [ ] Live counters: active agents, total events, tool calls, avg gap, running cost
- [ ] Time window selector (1m, 3m, 5m, 10m, 30m, all)
- [ ] Regex search across events
- [ ] Model tags per event (opus-4-6, sonnet-4-6, haiku-4-5)
- [ ] Cost tree: per-agent, per-team, per-session breakdown
- [ ] Reference: configs/observability-events.yaml (16 event types defined)

## Phase 2 — CC Native Agent Teams Adapter

**Goal:** Use Claude Code's built-in team mechanics with our orchestration on top.

- [ ] New adapter mode: `cc-teams` using `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
- [ ] Orchestrator spawns as CC team lead, sub-agents via `--agent-id`, `--agent-name`, `--team-name`
- [ ] Team mailbox integration (`~/.claude/teams/<name>/inboxes/`)
- [ ] Agent color coding in tmux (`--agent-color`)
- [ ] Tiered model dispatch: Opus leads, Haiku bulk exploration, Sonnet workers
- [ ] TeamCreate → TaskCreate → spawn → work → SendMessage → TeamDelete lifecycle
- [ ] Delete-after-completion pattern (fresh context per run)
- [ ] PG tracking layered on top of native CC events
- [ ] Reference: configs/agent-teams.yaml

## Phase 3 — A2A Protocol Integration

**Goal:** MAE agents are first-class A2A citizens, Bilby can join sessions.

- [ ] A2A adapter implementing PlatformAdapter interface
- [ ] Agent card generation: `/.well-known/agent-card.json` for each spawned agent
- [ ] Agent discovery: query remote A2A endpoints to find available agents
- [ ] Bilby interop: MAE can delegate tasks to external A2A agents
- [ ] External agent registration: any A2A-compatible agent can join MAE sessions
- [ ] Task routing via A2A protocol (not just HTTP POST)
- [ ] Dashboard shows A2A agents alongside native agents

## Phase 4 — Library as Living System

**Goal:** `mae library` CLI that manages skills with bidirectional sync.

- [ ] `mae library list` — show all registered skills/agents/prompts from library.yaml
- [ ] `mae library install <name>` — fetch from source (GitHub or local), install to project/global
- [ ] `mae library add <name> <source>` — register new entry in library.yaml
- [ ] `mae library push <name>` — push local modifications back to source repo
- [ ] `mae library sync` — refresh all installed assets from sources
- [ ] `mae library search <query>` — keyword search across registry
- [ ] Dependency resolution: `requires: [skill:X]` installs prerequisites
- [ ] Role-scoped libraries: per-persona skill sets (engineer, support, ops)
- [ ] Meta-skills: `meta-agent`, `meta-skill`, `meta-prompt` generators
- [ ] Reference: library.yaml (skeleton in place)

## Phase 5 — Steer Architecture (Mac Mini Control)

**Goal:** Replace OpenClaw with 4 lightweight CLIs for Skippy's Mac Mini.

- [ ] Listen: FastAPI job server with YAML persistence
- [ ] Direct: Client CLI for sending prompts to Listen
- [ ] Drive: tmux session/run/send/logs/poll/fanout
- [ ] Steer: macOS GUI automation (see/click/type/OCR/scroll/drag)
- [ ] Observe-Act-Verify loop for GUI interaction
- [ ] Task specs with Instructions/Tasks/Deliverables/Proof-of-Work
- [ ] Time-boxed execution (5m default, configurable)
- [ ] Screenshot + log capture as proof of work
- [ ] Reference: configs/steer-architecture.yaml

## Phase 6 — Production Hardening

**Goal:** Reliable, monitored, self-healing production system.

- [ ] GitHub self-hosted runner for auto-deploy on merge
- [ ] Health check endpoint (`/healthz`) with PG connectivity status
- [ ] Graceful shutdown (drain active sessions, persist state)
- [ ] Session recovery: resume interrupted sessions from PG state
- [ ] Agent timeout enforcement (configurable per-role)
- [ ] Budget enforcement: hard stop at per-session and per-agent limits
- [ ] Prometheus metrics export (agent count, cost, latency, error rate)
- [ ] Grafana dashboard on existing monitoring stack
- [ ] Log aggregation to journald with structured fields
- [ ] Alerting: budget exceeded, agent stuck, dashboard down

## Phase 7 — Multi-User Experience

**Goal:** Multiple users running concurrent sessions with proper isolation.

- [ ] User authentication (simple token or cookie, not full OAuth)
- [ ] Per-user session isolation (users only see their own sessions)
- [ ] User preferences: default model, preferred team, notification settings
- [ ] Notification system: session complete, agent failed, budget warning
- [ ] Mobile-friendly dashboard (responsive CSS)
- [ ] Concurrent session support (multiple users running simultaneously)
- [ ] Admin view: admin sees all sessions, others see only theirs

## Phase 8 — Agent Intelligence

**Goal:** Agents that learn and improve across sessions.

- [ ] Expertise file persistence in PG (not just local .md files)
- [ ] Cross-session learning: agents load expertise from previous runs
- [ ] Agent performance tracking: success rate, cost efficiency, time per task
- [ ] Automatic model tier adjustment based on task complexity
- [ ] Self-improving prompts: agents can modify their own system prompts via library push
- [ ] Agent leaderboard: which persona/model combo is most effective for which task type

## Priority Order

1. **Phase 1** (Live Observability) — makes everything else debuggable
2. **Phase 2** (CC Agent Teams) — native integration, biggest capability jump
3. **Phase 6** (Production Hardening) — GH runner, health checks, monitoring
4. **Phase 3** (A2A) — Bilby interop, external agent support
5. **Phase 4** (Library) — skill management and self-improvement
6. **Phase 7** (Multi-User) — other users start using it
7. **Phase 5** (Steer) — Mac Mini control (depends on OpenClaw migration decision)
8. **Phase 8** (Agent Intelligence) — long-term, builds on everything else

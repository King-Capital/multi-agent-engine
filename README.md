<div align="center">

<!-- CI Badges -->
[![Tests](https://img.shields.io/github/actions/workflow/status/King-Capital/multi-agent-engine/agent-tests.yml?branch=main&label=tests&style=flat-square&logo=github)](https://github.com/King-Capital/multi-agent-engine/actions/workflows/agent-tests.yml)
[![Build](https://img.shields.io/github/actions/workflow/status/King-Capital/multi-agent-engine/dashboard-ci.yml?branch=main&label=build&style=flat-square&logo=github)](https://github.com/King-Capital/multi-agent-engine/actions/workflows/dashboard-ci.yml)
[![CodeQL](https://img.shields.io/github/actions/workflow/status/King-Capital/multi-agent-engine/security-scan.yml?branch=main&label=CodeQL&style=flat-square&logo=github)](https://github.com/King-Capital/multi-agent-engine/actions/workflows/security-scan.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Go](https://img.shields.io/badge/Go-1.22+-00ADD8?style=flat-square&logo=go&logoColor=white)](https://go.dev/)
[![Bun](https://img.shields.io/badge/Bun-runtime-f9f1e1?style=flat-square&logo=bun&logoColor=black)](https://bun.sh/)

# Multi-Agent Engine

**Ship code with an army of AI agents -- orchestrated, verified, and battle-tested across model families.**

<br/>

[Quick Start](#-quick-start) · [Features](#-features) · [Architecture](#-architecture) · [Chains](#-chains) · [Agents](#-agents) · [Dashboard](#-dashboard) · [Contributing](#-contributing)

</div>

---

## Release Status

Current stable release: **v1.0.21**.

The `VERSION` file uses standard stable SemVer. The auto-version workflow resumes from this value and applies normal patch/minor/major bumps after merged PRs.

This release ships the Pi adapter, the A2A adapter, and the echo dry-run adapter. Claude Code and Codex adapters are planned work and should not be documented as shipped until they have end-to-end smoke coverage.

## ✨ Features

- **Multi-Model Orchestration** -- Route tasks through Pi, A2A-compatible services, or dry-run echo adapters with per-agent model tier control
- **10 Chain Types** -- From quick reviews to full-SDLC pipelines with plan → build → parallel validate → swarm review
- **Cross-Model Verification** -- Parallel teams run on *different* model families, catching blind spots no single model finds
- **Real-Time Dashboard** -- Go API + React dashboard with SSE live agent activity, run history, and pipeline visualization
- **Red Team / Blue Team** -- Adversarial + correctness review running in parallel, synthesized by an orchestrator
- **Pi SDK Integration** -- First-class adapter for the Pi coding agent, with A2A support for protocol-compatible agents
- **Sandbox Pooling** -- Agents execute in isolated sandboxes with pooled resource management
- **Pipeline State & Resume** -- Chains checkpoint state so interrupted runs can resume from the last completed step
- **Cost Tracking** -- Per-run token usage and cost breakdown across all model tiers
- **Damage Control Rules** -- Configurable guardrails prevent agents from running destructive commands

---

## 🎬 Demo

> 🚧 **Coming soon** -- GIF / video walkthrough of a full `plan-build-review` run with the live dashboard.

---

## 🏗 Architecture

```
                            User / CLI
                                │
                           Orchestrator
                          (quality model)
                         ╱      │       ╲
                   Planning  Engineering  Validation
                     Lead       Lead        Lead
                      │          │           │
                    Scout     Builder    Reviewer
                                        Security
                                        Adversarial
                                        Correctness
                                        Quality

    ┌─────────────────────────────────────────────────────────┐
    │  Parallel teams (Engineering B, Validation B) use       │
    │  different model families for cross-model verification. │
    │                                                         │
    │  Swarm mode splits into Red Team + Blue Team for        │
    │  adversarial vs. correctness review in parallel.        │
    └─────────────────────────────────────────────────────────┘

    Dashboard (Go API + React SPA) ─▶ SSE event stream
```

### Distributed Deployment

The engine CLI and dashboard can run on **different hosts**. The CLI streams events to a central dashboard over HTTP:

```
  Host A (CLI)  ──── events ────▶  Dashboard Server (Go + PG)
  Host B (CLI)  ──── events ────▶  Dashboard Server (Go + PG)
                                              │
                                     Reverse Proxy (optional)
                                              │
                                     your-dashboard.example.com
```

---

## 🚀 Quick Start

### Prerequisites

| Tool | Required For | Install |
|------|-------------|---------|
| [Bun](https://bun.sh) | Engine CLI (all hosts) | See bun.sh |
| [just](https://github.com/casey/just) | Justfile shortcuts (optional) | `brew install just` |
| [Go](https://go.dev) (1.22+) | Dashboard server only | `brew install go` |
| [Node.js](https://nodejs.org/) | Dashboard React build only | See nodejs.org |

> **CLI-only hosts** only need `bun`. Go is only needed on the dashboard server. Node.js is only needed when rebuilding the React dashboard assets.

### Install & Run

```bash
# Clone
git clone https://github.com/King-Capital/multi-agent-engine.git
cd multi-agent-engine

# Install dependencies
cd engine && bun install && cd ..

# (Optional) Build standalone CLI binary
just build

# Point at the dashboard server (set in ~/.mae/config or shell profile)
export MAE_DASHBOARD_URL="http://your-dashboard-host:8400"

# Optional: expose a small run-specific scratch folder to worker worktrees.
# Use a narrow path; MAE does not copy the entire .goal-runs tree by default.
export MAE_WORKTREE_CONTEXT_PATHS=".goal-runs/current-run"

# Run your first task -- plan, build, and review
just task "add input validation to the signup handler"

# Dry run (echo adapter, no real API calls)
just dry "refactor the auth module"

# Start the dashboard (dashboard server only)
just dashboard-build && just dashboard
```

### Remote Dashboard

```bash
# Add to ~/.zshrc, ~/.bashrc, or ~/.mae/config for persistence
export MAE_DASHBOARD_URL="http://your-dashboard-host:8400"

# Or pass per-invocation
bun engine/cli.ts task "your task" --dashboard "$MAE_DASHBOARD_URL"
```

Any host with `bun` can run agent teams and stream results to the central dashboard.

Project-specific skills can be added under `.mae/skills/` or `.mae/project-skills/` as Markdown/YAML files. Optional frontmatter supports `name` and `scope`; `scope: all` applies to every agent, while a role or persona-name scope only injects into matching prompts.

For dogfood/audit runs, `MAE_WORKTREE_CONTEXT_PATHS` accepts comma- or colon-separated relative paths. Each path is copied into worker git worktrees with symlinks skipped and size/file-count caps applied.

---

## 🔗 Chains

10 composable chain types, from surgical reviews to full SDLC pipelines:

| Chain | What It Does |
|-------|-------------|
| `plan-build-review` | Full dev workflow: plan → implement → validate |
| `scout-then-plan` | Explore the codebase first, then produce a plan |
| `build-verify` | Builder-verifier loop with 3-attempt escalation |
| `parallel-build` | Same task across multiple model families -- best result wins |
| `review-only` | Code review + security check on existing changes |
| `full-sdlc` | Complete SDLC: scout → plan → parallel build → parallel validate |
| `swarm-review` | Red team + blue team in parallel, orchestrator synthesizes |
| `red-blue` | Red team attacks, blue team defends -- competing perspectives |
| `scout-swarm` | Scout first, then swarm review flagged areas |
| `build-then-swarm` | Build with engineering, then swarm review the output |

---

## 🤖 Agents

| Agent | Role | Model Tier |
|-------|------|------------|
| **Orchestrator** | Routes tasks to teams, synthesizes results | quality |
| **Planning Lead** | Implementation plans, risk assessment | quality |
| **Scout** | Fast codebase exploration, file discovery, triage | fast |
| **Builder** | Code implementation, builds and tests | main |
| **Code Reviewer** | Correctness review, P0-P3 grading | quality |
| **Security Reviewer** | OWASP checks, injection, credential leaks, prompt injection | quality |
| **Validation Lead** | Coordinates review teams, issues final grade | quality |
| **Adversarial Reviewer** | Devil's advocate, assumption challenging, attack vectors | quality |
| **Correctness Reviewer** | Atomic claim verification, type safety, spec compliance | quality |
| **Quality Reviewer** | Maintainability, naming, structure, duplication, dead code | pro |

---

## 👥 Teams

| Team | Purpose | Lead Model |
|------|---------|------------|
| **Planning** | Codebase analysis, implementation plans, risk assessment | quality |
| **Engineering** | Code implementation, feature building, bug fixing | quality |
| **Engineering B** | Parallel implementation with a *different* model family | pro |
| **Validation** | Code review, security review, QA testing | quality |
| **Validation B** | Parallel validation with cross-model verification | pro |
| **Red Team** | Adversarial review, security testing, attack surface analysis | quality |
| **Blue Team** | Correctness verification, quality review, maintainability | pro |

---

## 📊 Dashboard

The real-time dashboard is a Go API server with an embedded **React SPA** from `dashboard-next/src/` and **SSE** for live updates. Session streams emit stable SSE `id:` values for persisted events and honor `Last-Event-ID` plus `?last_event_id=` replay, so browser reconnects catch up missed events. Legacy templ files remain in `dashboard/templates/` but are not the active UI.

| Feature | Detail |
|---------|--------|
| Live agent activity | Watch agents work in real time via SSE stream |
| Run history | Browse and replay past pipeline runs |
| Pipeline visualization | See chain steps, team assignments, and model routing |
| Multi-host support | Multiple CLI hosts stream into one dashboard |

**Access:** Set `MAE_DASHBOARD_URL` in `~/.mae/config` and open in your browser.

### Dashboard authentication

The dashboard protects all `/api/*`, `/htmx/*`, and `/metrics` endpoints by default. Public paths are limited to the SPA shell/assets, `/api/health`, and `/api/auth/login`.

- Browser users sign in through the React login page. Successful login creates a Secure, HttpOnly `mae_session` cookie backed by the `auth_sessions` table. Run the dashboard behind HTTPS in deployed environments; plain-HTTP localhost browser login is not supported by the secure cookie.
- API clients use `Authorization: Bearer <token>`. New admin-managed tokens live in `api_tokens`; legacy `users.api_token` values still load for compatibility.
- Admin users can open `/admin` to create/revoke API tokens. Newly generated token secrets are shown once; store bootstrap credentials and generated operational tokens in Vaultwarden (for the public deployment, item: `MAE Dashboard bootstrap credentials - ai-agents.rodaddy.live`).
- The Sessions sidebar loads the newest 100 sessions by default, with an explicit Load more control for older runs and a text Filter next to Sort. The main overview stats/charts remain all-session aggregates, so the sidebar count shows loaded/filtered rows while the center cards show global totals.
- Session detail includes Stream, Agents, Board, Progress, Files, Cost, and Replay tabs. The Board tab derives Kanban-style cards from agent/till-done/error events; the Agents tab hydrates colors/models/status from event history plus live SSE so reloads preserve swarm state.
- Steering messages can target the orchestrator or a selected agent. Targeted messages are stored in the message event `to` field and routed by exact agent id when the engine SSE listener receives them.
- First-run bootstrap: set `MAE_BOOTSTRAP_USERNAME=<existing admin username>` and `MAE_BOOTSTRAP_PASSWORD=<temporary strong password>` before starting the dashboard. Startup sets that user's password only when `password_hash` is empty, so later restarts will not overwrite a rotated password. Remove the env vars after login and rotate/store the final password in Vaultwarden.
- Legacy `users.api_token` bearer tokens still work for migration compatibility, but they are not visible in `/admin`, do not track `last_used_at`, and cannot be revoked there. Prefer creating replacement `api_tokens` from `/admin`, updating clients, then removing legacy tokens from `users.api_token`.
- If the database is unavailable, auth-required endpoints fail closed instead of falling back to anonymous API access.

---

## 🧭 Model Routing

| Tier | Default Model | Thinking Level | Used By |
|------|---------------|----------------|---------|
| `high` | opus-nocache | high | Orchestrators, leads, deep analysis |
| `medium` | sonnet-nocache | medium | Builders, workers, implementation |
| `fast` | sonnet-nocache | low | Scouts, triage, quick exploration |

**Thinking levels:** `off` < `minimal` < `low` < `medium` < `high` < `xhigh`

Cross-model pairs are configured in `configs/model-routing.yaml` to ensure builder and verifier always use different model families.

---

## 🔌 Adapters

| Adapter | Description |
|---------|-------------|
| `pi` | Delegates to Pi coding agent |
| `a2a` | Delegates to remote A2A-compatible agents |
| `echo` | Dry-run adapter -- prints what would happen |

---

## ⚡ Justfile Commands

<details>
<summary><strong>Click to expand full command reference</strong></summary>

| Command | Description |
|---------|-------------|
| `just task <description>` | Run plan-build-review (default workflow) |
| `just dry <description>` | Dry run with echo adapter |
| `just run <prompt> [args]` | Run a reusable prompt workflow |
| `just chain <name> [task]` | Run a named chain directly |
| `just pbr <task>` | Plan, build, and review a task |
| `just review <diff>` | Review code changes |
| `just scout <target>` | Scout/explore a codebase area |
| `just parallel <task>` | Build with multiple models, pick best |
| `just swarm <target>` | Full swarm review (red + blue teams) |
| `just red-blue <target>` | Red team attacks, blue team validates |
| `just scout-swarm <target>` | Scout first, then swarm review flagged areas |
| `just build-swarm <task>` | Build then swarm review the output |
| `just new-agent <name>` | Scaffold a new agent |
| `just adapters` | List available adapters |
| `just dashboard` | Start the dashboard server |
| `just dashboard-build` | Rebuild the dashboard binary |
| `just dashboard-seed` | Seed test data into the dashboard |
| `just test` | Run all tests |
| `just build` | Build the engine CLI as standalone binary |
| `just check` | Type check the engine |
| `just teams` | Show team configuration |
| `just chains` | Show available chains |
| `just prompts` | Show available prompts |
| `just persona <name>` | Show an agent's persona |
| `just expertise <name>` | Show an agent's expertise |
| `just rules` | Show damage-control rules |

</details>

---

## 🛠 Tech Stack

| Component | Technology |
|-----------|------------|
| **Engine** | Bun / TypeScript |
| **CLI** | Bun-compiled standalone binary |
| **Dashboard** | Go 1.22+ / chi router |
| **Dashboard UI** | React SPA + SSE |
| **Config** | YAML (teams, chains, model routing, damage control) |
| **Adapters** | Pi, A2A, Echo (dry-run) |
| **Testing** | bun:test |

---

## 🚢 Deployment

See [deploy/README.md](deploy/README.md) for full setup instructions:

- Dashboard server provisioning
- Remote CLI setup for multi-host streaming
- Caddy reverse proxy configuration
- User seeding and PostgreSQL setup

---

## 🤝 Contributing

Contributions are welcome! Here's how to get started:

1. **Fork** the repo and create a feature branch from `main`
2. **Install** dependencies: `cd engine && bun install`
3. **Make** your changes -- follow existing code style and patterns
4. **Test** your changes: `just test`
5. **Type-check**: `just check`
6. **Submit** a pull request with a clear description of what changed and why

### Guidelines

- All work happens on feature/fix branches -- never commit directly to `main`
- Keep PRs focused: one feature or fix per PR
- Add tests for new chain types or agents
- Update this README if you add new commands, agents, or chains
- Run `just check && just test` before submitting

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).

```
MIT License

Copyright (c) 2026 King Capital

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

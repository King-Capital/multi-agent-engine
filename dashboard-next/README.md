# MAE Dashboard

A modern real-time dashboard for the **Multi-Agent Engine** (MAE). Built with React, Vite, TypeScript, Tailwind CSS, and Recharts. Connects to the MAE Go API at `http://10.71.20.72:8400` (configurable).

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 20+ | Or Bun 1.x (compatible) |
| npm | 10+ | Comes with Node 20 |
| Go API | running | `http://10.71.20.72:8400` or custom |

---

## Quick Start

```bash
# Install dependencies
npm install
# or
bun install

# Start dev server (proxies API calls to http://10.71.20.72:8400)
npm run dev
# or
bun run dev
```

Open **http://localhost:5173** in your browser.

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with HMR on port 5173 |
| `npm run build` | Type-check + build to `dist/` |
| `npm run preview` | Preview production build locally on port 4173 |
| `npm run typecheck` | Run TypeScript type-check only (no emit) |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_BASE_URL` | `""` (proxy) | Override base URL for API calls in production |
| `VITE_API_URL` | `""` (proxy) | Alias for `VITE_API_BASE_URL` |
| `MAE_API_URL` | `http://10.71.20.72:8400` | Dev server proxy target (Vite config only) |

In development, Vite proxies `/api` and `/metrics` requests to the Go API automatically — no CORS issues.

For production builds, set `VITE_API_BASE_URL`:

```bash
VITE_API_BASE_URL=https://mae.example.com npm run build
```

---

## Production Build

```bash
npm run build
# Outputs to dist/
```

The `dist/` folder is a standalone SPA — serve it with any static file server:

```bash
# Preview production build locally
npm run preview

# Or serve with any static server
npx serve dist
```

---

## API Endpoints

The dashboard consumes these MAE Go API endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/pg/sessions` | List all sessions |
| GET | `/api/pg/sessions/:id` | Single session detail |
| GET | `/api/pg/sessions/:id/agents` | All agents for a session (LiveAgent shape) |
| GET | `/api/pg/sessions/:id/events` | Historical events from Postgres |
| GET | `/api/pg/sessions/:id/diff` | Files touched during session |
| GET | `/api/pg/stats` | Aggregated stats (cost, sessions, agents) |
| GET | `/api/pg/history` | Session history with cost aggregates |
| GET | `/api/health` | Health check + DB status |
| GET | `/api/sessions/:id/stream` | SSE stream for live events |
| GET | `/api/stream` | Global SSE stream (all sessions) |
| POST | `/api/sessions/:id/message` | Send message to session orchestrator |
| GET | `/metrics` | Prometheus metrics (raw text) |

---

## Architecture

### Component Tree

```
App
├── SessionSidebar           — searchable session list with live status
└── Detail (selected session)
    └── SessionTabs          — tabbed detail view
        ├── Stream tab       — live + historical event feed + message input
        ├── Agents tab       — AgentGraph (SVG) + AgentDetail slide-in panel
        ├── Progress tab     — TillDone real-time checklist
        ├── Files tab        — FilesView folder tree of changed files
        └── Cost tab         — CostBreakdown table + recharts bar chart
```

### Data Flow

```
Go API (http://10.71.20.72:8400)
    │
    ├── REST (polling)
    │   ├── /api/pg/sessions      → SessionSidebar (5s interval)
    │   ├── /api/pg/sessions/:id/agents → AgentGraph, CostBreakdown (15s)
    │   ├── /api/pg/sessions/:id/events → StreamTab history (10s)
    │   ├── /api/pg/sessions/:id/diff   → FilesView (on mount)
    │   └── /api/pg/stats               → Stats charts (15s)
    │
    └── SSE (real-time)
        ├── /api/sessions/:id/stream → AgentGraph live updates
        │                             TillDone real-time progress
        │                             StreamTab live events
        └── /api/stream (global)  → SessionSidebar live session list
```

### Key Source Files

```
src/
├── App.tsx                   — Root: session sidebar + Detail orchestration
├── lib/
│   ├── api.ts                — REST client + SSE subscribeToSession()
│   ├── types.ts              — Shared TypeScript interfaces (LiveAgent, etc.)
│   └── utils.ts              — cn(), formatCurrency(), formatDuration(), etc.
├── hooks/
│   ├── usePolling.ts         — Generic polling hook with cleanup
│   └── useEventStream.ts     — SSE hook with exponential backoff reconnect
└── components/
    ├── SessionTabs.tsx       — Tab navigation integrating all sub-views
    ├── AgentGraph.tsx        — SVG tree graph of agent parent/child hierarchy
    ├── AgentDetail.tsx       — Slide-in panel: agent metadata, events, files
    ├── TillDone.tsx          — Animated till_done progress checklist
    ├── FilesView.tsx         — Folder-grouped file change list
    ├── CostBreakdown.tsx     — Per-agent cost table + recharts bar chart
    ├── EventStream.tsx       — Full-featured event stream (standalone use)
    ├── ReplayPlayer.tsx      — Timeline replay of historical events
    └── ui/
        ├── tabs.tsx          — Headless tab primitives (no Radix dependency)
        ├── button.tsx        — CVA-based button
        ├── card.tsx          — Card layout components
        ├── badge.tsx         — Status badges
        ├── input.tsx         — Text input
        └── scroll-area.tsx   — Radix-based scrollable container
```

---

## Features

### Session Sidebar
- Auto-refreshes every 5 seconds
- Full-text search across name, ID, chain, status
- Live status badge (active/completed/error/waiting)
- Session age and chain shown inline

### Stream Tab
- Merges historical Postgres events with live SSE events
- Color-coded by event type (agent_spawn, tool_call, message, error, etc.)
- Message input to steer the session orchestrator
- Auto-scrolls to latest events

### Agent Graph Tab
- Interactive SVG directed graph of agent hierarchy (parent→child via `parent_id`)
- Nodes colored by `team_color`, labeled with name + role + model
- Status indicators: running (pulse animation), done (solid), error (red), blocked (amber)
- Cost label per node
- Click a node to open the **AgentDetail** slide-in panel
- Real-time SSE updates: `agent_spawn`, `agent_done`, `cost_update` events animate live

### Agent Detail Panel
- Triggered by clicking any graph node
- Shows: name, role, model, team, status, cost, tokens used, elapsed time
- Context window progress bar (warns at >80%, danger at >95%)
- Persona file path
- Files touched (from `tool_call` events with `file_path`)
- Filtered event log for this agent

### Progress Tab (TillDone)
- Renders `TillDoneState` from SSE `tilldone` events in real-time
- Animated spinner on active item, checkmark on completed
- Smooth progress bar with gradient fill
- "All criteria met" banner at 100%

### Files Tab
- Fetches `/api/pg/sessions/:id/diff`
- Folder-grouped expandable tree
- File-type icons (TypeScript, Go, Python, JSON, etc.)
- Status badges (Added/Modified/Deleted/Renamed) with diff counts when available

### Cost Tab
- Per-agent cost table sorted by spend
- Recharts bar chart (top 8 agents, colored by team)
- Summary cards: total cost, total tokens, agent count
- Cost share percentage bar per agent

---

## Screenshots

> _Add screenshots here after running the dashboard against a live MAE session._

| View | Description |
|------|-------------|
| `docs/screenshots/overview.png` | Session sidebar + empty state |
| `docs/screenshots/stream.png` | Live event stream tab |
| `docs/screenshots/agents.png` | Agent graph SVG visualization |
| `docs/screenshots/cost.png` | Cost breakdown tab |

---

## Development Notes

### Adding a new tab
1. Add a new `TabsTrigger` + `TabsContent` pair in `SessionTabs.tsx`
2. Create the component in `src/components/`
3. Import and render it inside the `TabsContent`

### Theming
All components follow the dark theme defined in `src/index.css`:
- Body: `bg-background` (slate-950)
- Cards: `bg-card` / `.glass` class (slate-950/70 + backdrop-blur)
- Borders: `border-border` (zinc-800)
- Primary accent: `text-cyan-400` (`hsl(186 100% 50%)`)
- Agent colors: from API `team_color` field (hex string)

### SSE reconnection
`useEventStream` (and `subscribeToSession` in `AgentGraph`) implement exponential backoff reconnection: starts at 1s, doubles up to 30s max on each failed connection.

### Type safety
All API shapes are defined in `src/lib/types.ts`:
- `LiveAgent` — full agent record from Go's `models.Agent`
- `LiveEvent` / `EventData` — SSE event with typed data fields
- `TillDoneState` / `TillDoneItem` — till_done progress
- `DiffFile` — normalised file change record

---

## License

Private. Internal MAE tooling.

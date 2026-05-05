# Claude Code Multi-Agent Orchestration with Opus 4.6, Tmux and Agent Sandboxes

**Source:** https://www.youtube.com/watch?v=RpUTF_U4kiw
**Extracted:** 2026-05-05 | 144 frames analyzed

## Orchestration Pattern

1. User runs `cldyo` alias (CC with agent teams enabled + Opus + skip-permissions)
2. Opus (team lead) creates task list, spawns N agents in parallel
3. Sub-agents work independently, send results via SendMessage to team mailbox
4. Lead reads `~/.claude/teams/<name>/inboxes/team-lead.json`, compiles report
5. Lead calls TeamDelete to clean up -- forces fresh context next run

## Environment Setup

```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
export CLAUDECODE=1
alias cldyo="claude --dangerously-skip-permissions --model opus"
```

## Claude Code Agent Flags

| Flag | Purpose |
|------|---------|
| `--agent-id sbx-agent-1` | Unique identifier |
| `--agent-name sbx-agent-1` | Display name |
| `--team-name sandbox-reboot` | Team grouping |
| `--agent-color blue` | Visual identification in tmux |
| `--parent-session-id <uuid>` | Links to lead's session |
| `--agent-type general-purpose` | Role type |
| `--dangerously-skip-permissions` | No permission prompts (sandbox only) |
| `--model opus` | Model selection |

## Tmux Layout

- Left pane: `@main` (Opus orchestrator) -- task list, status updates
- Right panes: `@agent-1` through `@agent-N`, each in own pane
- Color-coded labels per agent
- Navigation: `shift+up` to manage, standard pane switching

## Sandbox/Isolation

- **E2B cloud sandboxes**: Each agent gets isolated sandbox (12-hour timeout)
- Sandboxes include: filesystem, Node.js/Python, browser ports (9223-9226)
- `sbx sandbox list` CLI for management
- Skill: `~/.claude/skills/agent-sandboxes/sandbox_cli/`
- Each sandbox has own frontend (5173) and backend (8000) URLs

## Agent Communication

- **SendMessage tool**: Sub-agents → team lead mailbox
- **TaskUpdate events**: Status changes (#1 → completed, #2 → in_progress)
- **Team mailbox**: `~/.claude/teams/<name>/inboxes/` as JSON files
- **TaskList/TaskGet**: Lead tracks progress

## Observability Dashboard (localhost:5173)

- Real-time Agent Event Stream
- Live Activity Pulse: agent count, events, tools, avg gap
- Timeline with success/failure icons per tool call
- Agent session filters as colored pills
- Event types: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, TaskCreate, TaskUpdate, SendMessage, TeamDelete, Stop, SubagentStop, Notification
- Search with regex support
- Model tags per event (opus-4-6, haiku-4-5)
- Time window: 1m, 3m, 5m, 10m

## Model Strategy

- **Opus 4.6**: Team lead (plans, delegates, synthesizes) + complex tasks
- **Haiku 4.5**: Bulk exploration/summarization (8 agents at once, cheap)
- Lead context stays low (15-31%) while delegating heavy work

## Applicable to MAE

1. Add CC agent teams as adapter (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`)
2. `cldyo` alias for quick orchestrator launch
3. Model observability dashboard: event stream, agent filters, tool timeline, live counters
4. Team mailbox pattern for agent result collection
5. Tiered model strategy: Opus orchestration, Haiku bulk work
6. Lifecycle: TeamCreate → TaskCreate → spawn → parallel work → SendMessage → TeamDelete
7. Agent color coding + named agents for visual identification
8. Delete-after-completion pattern for fresh context
9. E2B sandbox integration for isolated untrusted work
10. `--agent-type` flag maps to MAE Red/Blue team roles

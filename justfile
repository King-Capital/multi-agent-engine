# Multi-Agent Orchestration System
# Usage: just <command> [args]
# Alias: alias j='just' in your shell

engine := "bun engine/cli.ts"
dashboard_bin := "dashboard/dashboard-bin"

# --- Core Commands ---

# Run a reusable prompt workflow
run prompt *args:
    {{engine}} run {{prompt}} {{args}}

# Run a named chain directly
chain name *task:
    {{engine}} chain {{name}} {{task}}

# Run plan-build-review on a task (default workflow)
task *description:
    {{engine}} task {{description}}

# Dry run (echo adapter, no real agents)
dry *description:
    {{engine}} task {{description}} --dry-run

# --- Quick Workflows ---

# Plan, build, and review a task
pbr *task:
    {{engine}} run plan-build-review {{task}}

# Review code changes
review *diff:
    {{engine}} run review {{diff}}

# Scout/explore a codebase area
scout *target:
    {{engine}} run scout {{target}}

# Build same task with multiple models, pick best
parallel *task:
    {{engine}} run parallel-build {{task}}

# --- Swarm Commands ---

# Full swarm review: red team + blue team in parallel
swarm *target:
    {{engine}} run swarm-review {{target}}

# Red team attacks, blue team validates (sequential)
red-blue *target:
    {{engine}} run red-blue {{target}}

# Scout first, then swarm on flagged areas
scout-swarm *target:
    {{engine}} chain scout-swarm {{target}}

# Build then swarm review the output
build-swarm *task:
    {{engine}} chain build-then-swarm {{task}}

# --- Agent Management ---

# Scaffold a new agent
new-agent name role='worker' team='Engineering' model='main':
    {{engine}} new-agent {{name}} {{role}} {{team}} {{model}}

# List available adapters
adapters:
    {{engine}} adapters

# --- Dashboard ---

# Start the dashboard server
dashboard:
    cd dashboard && ./dashboard-bin

# Rebuild the dashboard binary
dashboard-build:
    cd dashboard && templ generate ./templates/ && go build -o dashboard-bin .

# Seed test data into the dashboard
dashboard-seed:
    cd dashboard && bash seed-test.sh

# --- Development ---

# Run all tests
test:
    cd engine && bun test

# Build the engine CLI as a standalone binary
build:
    cd engine && bun build cli.ts --target=bun --outfile=../agent

# Type check the engine
check:
    cd engine && bunx tsc --noEmit

# --- CC Native Agent Teams ---

# Launch Opus orchestrator with CC agent teams enabled
cldyo *args:
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude --dangerously-skip-permissions --model opus {{args}}

# Launch Sonnet worker with CC agent teams enabled
cldys *args:
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude --dangerously-skip-permissions --model sonnet {{args}}

# --- Library ---

# List all registered skills, agents, and prompts
library:
    @echo "=== Skills ===" && grep '  - name:' library.yaml | head -20
    @echo "=== Agents ===" && grep '  - name:' library.yaml | tail -20

# --- Info ---

# Show the full team configuration
teams:
    @cat agents/teams/teams.yaml

# Show available chains
chains:
    @cat agents/teams/chains.yaml

# Show available prompts
prompts:
    @ls -1 prompts/*.md | sed 's|prompts/||;s|\.md||'

# Show an agent's persona
persona name:
    @cat agents/personas/{{name}}.md

# Show an agent's expertise/mental model
expertise name:
    @cat agents/expertise/{{name}}.md

# Show damage-control rules
rules:
    @cat configs/damage-control-rules.yaml

# Pi as OpenClaw Backend Runtime -- Feasibility Study

**Issue:** #104
**Approach:** Bilby first, then Skippy

## Executive Summary

Pi (v0.74.0, @earendil-works/pi-coding-agent) is a model-agnostic coding agent
with a 4-tool architecture (bash, read, write, grep/find), extension system,
and RPC mode for programmatic control. This doc evaluates whether it can
replace Claude Code as the coding runtime behind OpenClaw.

## Architecture Comparison

### OpenClaw (current)
- **Runtime:** Claude Code (Anthropic-locked)
- **Tools:** exec, read, write, browser, message, memory, sessions, web_search, web_fetch
- **Hooks/Gates:** Pre/post tool execution gates (ob-gate, sop-gate, heartbeat-gate, etc.)
- **Memory:** Built-in MEMORY.md + memory/*.md + OB integration
- **Model:** Anthropic only (sonnet, opus, haiku) via direct API or LiteLLM
- **Context:** 1M window, auto-compaction at configurable thresholds

### Pi (proposed)
- **Runtime:** Model-agnostic (Anthropic, OpenAI, Gemini, local via LiteLLM)
- **Tools:** bash, read, write, grep + find (4 built-in)
- **Extensions:** TypeScript extensions with full lifecycle hooks
- **Memory:** Via extensions (pi-open-brain, pi-continue, pi-supermemory)
- **Model:** Any model via providers or LiteLLM
- **Context:** Model-dependent, pi-continue handles compaction

## Tool Mapping

| OpenClaw Tool | Pi Equivalent | Gap |
|---------------|---------------|-----|
| exec (shell) | bash | ✅ Direct match |
| read | read | ✅ Direct match |
| write | write | ✅ Direct match (full file) |
| edit | write | ⚠️ Pi writes full files, no line-level edit |
| browser | ❌ | 🔴 No browser tool -- need extension |
| message | ❌ | 🔴 Need pi-messenger or extension |
| memory_search | pi-open-brain ext | ⚠️ Extension, not built-in |
| memory_get | pi-open-brain ext | ⚠️ Extension, not built-in |
| web_search | bash + curl | ⚠️ Indirect via bash |
| web_fetch | bash + curl | ⚠️ Indirect via bash |
| sessions_spawn | pi-subagents ext | ⚠️ Extension, not built-in |
| sessions_send | pi-subagents ext | ⚠️ Extension, not built-in |
| image | ❌ | 🔴 No image analysis tool |

## Hook/Gate Mapping

| OpenClaw Gate | Pi Extension Equivalent | Status |
|---------------|------------------------|--------|
| ob-gate | pi-open-brain (auto-recall) | ✅ Built |
| sop-gate | Extension: check OB before process tasks | 📋 TODO |
| heartbeat-gate | Extension: periodic state check | 📋 TODO |
| task-context | Extension: inject TASKS.md | 📋 TODO |
| no-deaf-polls | Extension: block long waits | ✅ Built (pi-safety-gate) |
| Jeraptha (destructive git) | pi-safety-gate | ✅ Built |

## What Pi Does Better

1. **Model freedom** -- Use opus for deep work, GPT-5.5 for verification, Gemini for cheap passes. No vendor lock-in.
2. **Extension ecosystem** -- TypeScript extensions are simpler than OpenClaw hooks. No YAML config needed.
3. **Startup time** -- Pi starts in <2s vs CC's 5-10s cold start.
4. **Cost control** -- MODEL_PRICING + budget enforcement at the orchestrator level.
5. **Multi-agent native** -- RPC mode + pi-subagents. CC needs OpenClaw to orchestrate.

## What Pi Is Missing

1. **Browser automation** -- OpenClaw has full Playwright-based browser control. Pi has nothing.
2. **Image analysis** -- OpenClaw can analyze screenshots. Pi can't.
3. **Channel routing** -- OpenClaw routes to Discord/Telegram/iMessage/etc. Pi is CLI-only.
4. **Session management** -- OpenClaw manages persistent sessions, thread-bound spawns, etc.
5. **Line-level edit** -- OpenClaw's edit tool modifies specific line ranges. Pi overwrites entire files.
6. **Approval workflow** -- OpenClaw has native approval cards. Pi has confirm() in interactive mode only.

## Migration Plan

### Phase 1: Bilby on Pi (Test)
- [ ] Create Bilby Pi config (~/.pi/agent/settings.json)
- [ ] Port Bilby's system prompt to Pi agents.md
- [ ] Install required extensions (pi-open-brain, pi-safety-gate, pi-context-workflow)
- [ ] Configure LiteLLM models in Pi's models.json
- [ ] Run Bilby's typical workflows (code review, bug fix, feature build)
- [ ] Document gaps and workarounds
- [ ] Run for 1 week, collect metrics

### Phase 2: Evaluate Results
- [ ] Compare: completion quality, cost, speed, reliability
- [ ] List showstoppers (if any)
- [ ] Decide: migrate Skippy or abort

### Phase 3: Skippy on Pi (if Phase 2 passes)
- [ ] Port Skippy's full config (SOUL.md, USER.md, AGENTS.md, TOOLS.md)
- [ ] pi-skippy-soul extension (already built)
- [ ] Integrate with OpenClaw as backend (Pi RPC ← OpenClaw session manager)
- [ ] Keep OpenClaw for channel routing, sessions, memory
- [ ] Pi handles: code execution, tool calls, model routing

## The Hybrid Architecture

The likely outcome isn't "replace OpenClaw with Pi" but "Pi as OpenClaw's coding backend":

```
User → Discord/Telegram/iMessage
  → OpenClaw (channel routing, sessions, memory, browser)
    → Pi (coding agent, tool execution, model routing)
      → LiteLLM (Anthropic/OpenAI/Gemini)
```

OpenClaw stays for what it's good at (channels, memory, browser, approvals).
Pi replaces Claude Code for what IT's good at (coding, multi-model, extensions).

## Decision Matrix

| Capability | Keep OpenClaw | Move to Pi | Notes |
|-----------|:---:|:---:|-------|
| Channel routing | ✅ | | Discord, Telegram, iMessage |
| Session management | ✅ | | Persistent sessions, threads |
| Memory (MEMORY.md) | ✅ | | Built-in, auto-compaction |
| Browser automation | ✅ | | Playwright-based |
| Image analysis | ✅ | | Screenshot analysis |
| Approval workflow | ✅ | | Native approval cards |
| Code execution | | ✅ | bash, read, write |
| Model routing | | ✅ | Multi-model, cross-model |
| Extensions | | ✅ | Simpler than OC hooks |
| Multi-agent orchestration | | ✅ | MAE + Pi RPC |
| Cost tracking | | ✅ | MODEL_PRICING |
| Safety gates | | ✅ | pi-safety-gate |


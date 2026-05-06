# Mac Mini Agents: OpenClaw is a NIGHTMARE... Use these SKILLS instead

**Source:** https://www.youtube.com/watch?v=LOazLNQnB80
**Extracted:** 2026-05-05 | 158 frames analyzed

## OpenClaw Issues

- **Security**: 400K lines of vibe-coded code, RCE vulnerabilities, supply chain poisoning, malicious skills in registry
- **Vibe code**: Generates infinite code without understanding
- **Self-destruction**: Unrestricted agents can accidentally delete their own server
- **No observability**: Agents trapped in terminal with no proof of work
- **Prompt injection**: Registry skills are untrusted code with full access

## Steer Architecture (Replacement)

4 Python CLI apps + 2 skills replace entire OpenClaw platform:

```
Trigger Layer:     Cron | Build | Direct | Agent
Job Dispatch:      Listen (FastAPI + Workers + YAML Jobs)
Orchestration:     Drive (terminal) + Steer (GUI)
Execution:         tmux + macOS Accessibility/OCR/AXTree/CGEvent
Host Apps:         Safari, Finder, Notes, Mail, VS Code
Custom Agents:     Claude Code, Pi Agent, Gemini CLI, Codex CLI
```

## Core CLIs

| CLI | Purpose | Commands |
|-----|---------|----------|
| **Listen** | FastAPI job server, YAML persistence | start, get, list, stop, clear |
| **Direct** | Client CLI sends prompts to Listen | send, jobs, status |
| **Drive** | Terminal automation via tmux | session, run, send, logs, poll, fanout |
| **Steer** | GUI automation (Swift, macOS A11y) | see, click, type, ocr, scroll, drag |

## Key Patterns

- **Justfile as command runner**: `j listen`, `j send "prompt"`, `j jobs`
- **YAML job persistence**: Jobs stored as YAML with id, status, prompt, timestamps
- **Task specs**: Markdown with Instructions/Tasks (checklist)/Deliverables
- **5-minute time limit**: Agents wrap up and deliver if approaching limit
- **Proof of work**: Screenshots + logs as evidence, AirDrop results
- **Observe-Act-Verify loop**: steer see → one action → read output → verify → recover → clean up

## Project Structure

```
mac-mini-agent/
  .claude/
    agents/listen-drive-and-steer-system-prompt.md
    commands/install-agent-sandbox.md, prime.md
    skills/drive/SKILL.md, steer/SKILL.md
  apps/direct/, drive/, listen/, steer/
  specs/TASK-TEMPLATE.md, *.md
  justfile
```

## Applicable to Our Setup

1. Drive CLI for Skippy's Mac Mini (tmux session/run/send/logs/poll/fanout)
2. Listen/Direct pattern maps to MAE orchestration engine
3. SKILL.md files over OpenClaw skill registry (Jeraptha already validates)
4. Task spec format (Instructions/Tasks/Deliverables) as standard job contract
5. Proof-of-work: screenshot/log capture in agent lifecycle
6. Time-boxed execution with mandatory summarize-and-deliver

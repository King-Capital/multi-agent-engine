## Review

- Correct: The Claude command is a session-mode prompt, not a tool workflow. Its core semantics are: stop reflexive agreement, challenge proposals, identify edge cases/scaling/maintenance/security/performance issues, present alternatives, and agree only after critical analysis (`/Users/rico/.claude/commands/critical-mode.md:7-16`, `:43-56`). The Pi port should therefore be a lightweight session-state extension that injects a durable system-prompt addendum, not a MAE chain, subagent launcher, or shell workflow.

- Correct: Pi already has the right extension pattern in `/goal`: register a slash command, persist state with `pi.appendEntry`, restore from `ctx.sessionManager.getEntries()`, update status/widget UI, and modify the prompt in `before_agent_start` (`/Users/rico/.pi/agent/extensions/goal.ts:36-69`, `:177-227`, `:242-249`). `/critical-mode` should reuse this shape.

- Note: Exact implementation shape recommended:
  1. Add a new extension file such as `/Users/rico/.pi/agent/extensions/critical-mode.ts` rather than merging into `/goal`; critical thinking mode is orthogonal to goal tracking and should be independently toggled.
  2. Define `type CriticalModeState = { enabled: boolean; updatedAt?: number; reason?: string }` and constants like `CUSTOM_TYPE = "critical-mode-state"`, `STATUS_KEY = "critical-mode"`, `WIDGET_KEY = "critical-mode"`.
  3. Implement `restoreCriticalMode(ctx)`, `saveCriticalMode(pi)`, `updateUi(ctx)`, and `criticalModeHelp()` using the same persistence/UI conventions as `/goal` (`goal.ts:36-69`, `:86-97`).
  4. Register `pi.registerCommand("critical-mode", ...)` with completions: `on`, `off`, `show`, `status`, `toggle`, `help`; default with no args should enable mode and show a success notification to match Claude's command activation UX (`critical-mode.md:20-22`, `:60-71`).
  5. In `before_agent_start`, if enabled, append a concise system-prompt addendum with Claude's semantics and add a hidden custom message for trace/session visibility, mirroring `/goal`'s returned `{ message, systemPrompt }` pattern (`goal.ts:227-249`).

- Note: Recommended system-prompt addendum should preserve the UX but avoid Claude-specific unavailable tooling. Pi's shim exposes `ctx.ui.select/input/confirm/editor` for extension commands (`/Users/rico/.pi/agent/extensions/types/pi-shims.d.ts:15-24`) but not an agent-facing `AskUserQuestion` tool. Therefore port the structured-question semantics as: "During analysis, present 1-3 concerns/trade-offs plainly. At decision points, ask one clear question at a time and wait for the user's answer; if Pi exposes a structured question UI in the future, prefer it." Do not literally require `AskUserQuestion`, because the inspected Pi command API does not provide it.

- Note: Integration with `/goal`: keep separate commands, but make prompt composition compatible. `/goal` already injects active-goal context in `before_agent_start` (`goal.ts:242-249`). `/critical-mode` should append its addendum to `event.systemPrompt` the same way and not overwrite existing prompt text. The combined behavior should be: interpret ambiguous work in service of the active goal, but challenge flawed paths before implementation. Suggested addendum wording: "When an active goal is present, critique proposed approaches in the context of that goal; do not derail into unrelated objections. Identify only material risks and alternatives. If the user's direction is sound, say why and proceed."

- Note: UX recommendation: status line should show a compact indicator such as `critical: on` while enabled, with a widget containing 3-5 bullets: "challenge assumptions", "identify edge cases", "present alternatives", "ask one decision question". This follows `/goal`'s status/widget precedent (`goal.ts:57-65`) without flooding the transcript.

- Note: Avoid over-enforcement. The Claude command says to identify 1-3 potential issues (`critical-mode.md:64-69`) and to challenge when there are material risks (`:45-51`). The Pi implementation should explicitly say "do not manufacture objections" and "do not block trivial/low-risk requests" to prevent adversarial UX drift.

- Note: Verification plan:
  - Typecheck/build the Pi extension package after adding the file and registering it in whatever extension loader/index is used by the Pi config.
  - Manual Pi session smoke test: run `/critical-mode`, confirm notification/status/widget, send a proposal with obvious trade-offs, verify response contains concise critique before action.
  - Toggle test: run `/critical-mode off`, verify status/widget clears and the next turn lacks the critical-mode addendum.
  - Persistence test: start a new turn/session branch where session entries are retained and verify `restoreCriticalMode` reloads the latest `critical-mode-state`, analogous to `/goal` restore behavior (`goal.ts:36-48`, `:222-224`).
  - Compatibility test with `/goal`: set `/goal ship X`, enable `/critical-mode`, then ask for a questionable implementation; verify the answer critiques in service of the goal rather than replacing or ignoring goal context.

- Blocker: The requested plan/progress files were not present at the supplied paths: `/Volumes/ThunderBolt/Development/ai-agents/platforms/multi-agent-engine/plan.md` and `/Volumes/ThunderBolt/Development/ai-agents/platforms/multi-agent-engine/progress.md`. This review is based on the available Claude command and Pi extension files only.

- Note: Not promoting because this was a one-off review/proposal task, not a repeated workflow needing a durable asset.

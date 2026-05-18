## Review

- Correct: Porting this as a Pi extension command is the right integration point. Existing Pi commands use `pi.registerCommand(...)` with optional completions and a handler (`/Users/rico/.pi/agent/extensions/goal.ts:177-220`), and session behavior is injected through `before_agent_start` (`/Users/rico/.pi/agent/extensions/goal.ts:227-250`). Claude's `/critical-mode` is purely prompt/behavioral text, not a shell workflow (`/Users/rico/.claude/commands/critical-mode.md:1-118`), so the minimal robust Pi port should also be state + prompt injection, not external process automation.

- Correct: The command should be a first-class Pi command named `critical-mode`, implemented as a new extension file such as `/Users/rico/.pi/agent/extensions/critical-mode.ts`. Keep it separate from `goal.ts`; critical mode is an orthogonal assistant-behavior toggle, while `/goal` owns goal persistence, one-turn nudges, session naming, and goal-specific prompt text (`goal.ts:3-21`, `goal.ts:133-168`, `goal.ts:242-250`).

- Note: Recommended implementation shape:
  1. Define a small `CriticalModeState` with `{ enabled: boolean; updatedAt?: number }` and a custom entry type like `critical-mode-state`.
  2. Add `restoreCriticalMode(ctx)`, `saveCriticalMode(pi)`, `updateUi(ctx)`, and `criticalModeHelp()` mirroring the simple state/restore pattern in `goal.ts:36-70`.
  3. Register `/critical-mode` with subcommands: no args/show/status => show state/help; `on`/`enable`/`start`/`activate` => enable; `off`/`disable`/`stop`/`deactivate`/`clear` => disable; `toggle` optional. Completions should follow `goalCompletions` style (`goal.ts:72-84`).
  4. On `session_start`, restore state and update status/widget, as `/goal` does (`goal.ts:222-225`).
  5. On `before_agent_start`, if enabled, append a concise critical-thinking prompt to `event.systemPrompt` and optionally add a hidden custom message. Use a status key/widget key distinct from `goal`, e.g. `critical-mode`.

- Note: Prompt content should be adapted, not copied verbatim. Preserve Claude semantics from `critical-mode.md:11-16`, `critical-mode.md:45-56`, and `critical-mode.md:64-69`: challenge assumptions, identify 1-3 problems, present trade-offs/alternatives, and agree only after analysis. Avoid Claude-specific wording/tool names unless Pi supports them. In particular, `AskUserQuestion` is Claude-specific in the source (`critical-mode.md:75-114`); Pi has the `pi-ask-user` package enabled (`/Users/rico/.pi/agent/settings.json:32-35`) and UI APIs like `confirm`, `select`, `input`, and `editor` in the extension shim (`/Users/rico/.pi/agent/extensions/types/pi-shims.d.ts:15-23`), but the prompt should say “use the available structured-question/user-question mechanism when a decision is needed” rather than hard-coding `AskUserQuestion` unless the package exposes that exact tool name in Pi.

- Note: Integration with `/goal` should happen by composition through prompt injection, not by editing `goal.ts` unless necessary. Both extensions can independently append to `systemPrompt` in `before_agent_start`. Critical-mode text should explicitly say it does not replace the active goal: when a goal is active, critique proposals in service of that goal. This avoids fighting `/goal`'s instruction to interpret ambiguous requests in service of the active goal (`goal.ts:249`).

- Blocker: Do not implement `/critical-mode` as a one-shot visible `pi.sendMessage` only. That would acknowledge activation but would not affect future assistant starts. The required persistence/injection mechanism is the custom-entry + `before_agent_start` pattern shown in `goal.ts:68-70` and `goal.ts:227-250`.

- Blocker: Do not make critical mode global by default. Claude's command says “for the rest of this session” (`critical-mode.md:20-22`, `critical-mode.md:60-62`). Pi session entries are the appropriate scope. A global settings edit would surprise future sessions and conflict with the source semantics.

- Note: Verification should include:
  - Typecheck/compile the extension set using the existing Pi extension tsconfig if available, e.g. from `/Users/rico/.pi/agent/extensions`: `bunx tsc -p tsconfig.json --noEmit` or the project’s documented Pi extension check.
  - Start a fresh Pi session and verify `/critical-mode on`, `/critical-mode show`, `/critical-mode off`, and completions.
  - Confirm status/widget updates when UI is present.
  - Confirm activation persists across turns in the same session by checking that a subsequent assistant turn receives the critical-mode prompt.
  - Confirm a new unrelated session is not critical by default unless explicitly re-enabled.
  - Confirm coexistence with `/goal`: set `/goal <text>`, enable `/critical-mode`, then verify the injected behavior includes both active goal context and critical-analysis behavior without clearing the goal or nudge state.

- Note: I could not inspect `plan.md` or `progress.md` because both requested paths were absent in the repo at review time. Evidence: read attempts returned ENOENT for `/Volumes/ThunderBolt/Development/ai-agents/platforms/multi-agent-engine/plan.md` and `progress.md`.

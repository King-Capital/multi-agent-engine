# PR #354 Pre-Merge Review Swarm

Head reviewed: `43a62ea6f4ed95c84e9ff2c6ddb571ed61fa492d`  
Branch: `pi-phase1-complete`  
Scope: `git diff main...HEAD` plus PR metadata/status checks.

## Verdict

**FAIL for PR readiness right now** — no material in-scope code blockers found in the reviewed diff, but PR metadata/status gates are not all green: GitHub reports `mergeStateStatus: BLOCKED`, `reviewDecision: REVIEW_REQUIRED`, and one CodeQL check is still pending in the status rollup.

## Findings

| Severity | File/Line | Issue | Required fix | Blocks PR |
|---|---:|---|---|---|
| P3 | PR metadata / checks | PR is not merge-ready despite code review being clean. `gh pr view 354` reports `mergeStateStatus=BLOCKED`, `reviewDecision=REVIEW_REQUIRED`; `gh pr checks 354` exits nonzero because one `CodeQL` check is pending while another CodeQL run is already successful. | Wait for the pending CodeQL check to complete or resolve duplicate/stale required check configuration, and obtain required approval/review state. | Yes |

## Convergence Matrix

| Gate | Status | Evidence |
|---|---|---|
| Pi structural base | PASS | `swarm-review` defines five canonical parallel teams with `read_only: true` and `lead_only: true` in `agents/teams/chains.yaml:251-286`; engine carries `leadOnly` through `PreparedTeamStep` and skips worker spawning in `engine/team-execution.ts:60-66,227-250,323-330`. |
| Codex: typed `PreparedTeamStep.leadOnly` | PASS | `engine/team-execution.ts:60-66`; `engine/types.ts` adds `lead_only` to `ParallelTeamStep`/`ChainStep`. |
| Codex: worker-spawn rejection | PASS | Live Pi trace gate counts non-lead `agent.start` and worker `agent_spawn` events at `scripts/certify-live-swarm:312-327`; regression at `scripts/certify-live-swarm-test:306-321`. |
| Codex: non-synthesis `CERTIFICATION_CONTRACT` leak gate | PASS | `non_synthesis_contract_artifacts` rejects contracts from non-synthesis artifacts at `scripts/certify-live-swarm:165-180,329-330`; prompt guards at `agents/teams/chains.yaml:255-289`; regression at `scripts/certify-live-swarm-test:336+`. |
| Codex: false-ready parser regression | PASS | `marks_certification_ready` rejects `certification_ready:false` / negated readiness at `scripts/certify-live-swarm`; regressions in `scripts/certify-live-swarm-test`. |
| Codex: lead prompt guard | PASS | Lead-only prompt explicitly forbids assignment spawning and non-synthesis contract emission in `engine/team-execution.ts:239-246`; per-team chain prompts repeat the guard in `agents/teams/chains.yaml:255-289`. |
| Claude: pipefail-safe empty-output scan | PASS | Empty-output scan uses `if grep ...; then printf; fi` inside the pipeline at `scripts/certify-live-swarm:157-162`, avoiding `set -euo pipefail` false failures. |
| Claude: timeout exit-code handling | PASS | `run_review` captures timeout/command exit separately and special-cases code `124` at `scripts/certify-live-swarm:357-363`. |
| Follow-up: exact required lead coverage | PASS | `missing_required_review_leads` requires all five canonical review teams at `scripts/certify-live-swarm:183-208`; regression rejects five non-canonical/wrong leads at `scripts/certify-live-swarm-test:214-225`. |
| Follow-up: repo-source read rejection | PASS | Live Pi trace gate rejects tool calls into `$root` outside the fixture workdir at `scripts/certify-live-swarm:335-336`; regression at `scripts/certify-live-swarm-test` for repo source reads. |

## Validation / CI Notes

Local validation run during review:

- `just check` — PASS (`cd engine && bunx tsc --noEmit`).
- `bun test engine/team-execution.test.ts` — PASS, 24 tests.
- `scripts/certify-live-swarm-test` — PASS, 36 checks.
- `just test` — PASS, 554 pass / 1 skip, plus certification harness tests.
- `bunx tsc --noEmit` from repo root — FAILS because there is no root `tsconfig.json`; project command is `just check` / `cd engine && bunx tsc --noEmit`, which passes.

PR status observed:

- Head SHA matches expected: `43a62ea6f4ed95c84e9ff2c6ddb571ed61fa492d`.
- `agent-review`, `check-docs`, `test`, and one `CodeQL` entry are successful.
- One `CodeQL` entry remains pending; `gh pr checks 354` exits nonzero.
- GitHub metadata says `mergeStateStatus=BLOCKED` and `reviewDecision=REVIEW_REQUIRED`.

## Evidence Accuracy

Planning docs accurately state that the full live Pi all-fixture run was explicitly approved and passed before final regression-only tightening, and that the final branch subsequently passed regression/echo/full test/typecheck gates. Evidence locations include `.planning/standard-swarm-v2/VALIDATION.md:188-196` and `.planning/standard-swarm-v2/PROGRESS.md:169-188`.

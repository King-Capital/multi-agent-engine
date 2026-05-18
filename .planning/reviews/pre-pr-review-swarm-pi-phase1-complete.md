# Pre-PR Review Swarm — pi-phase1-complete

Scope reviewed: current working-tree diff, including untracked planning docs and `scripts/certify-live-swarm-test`.

Verdict: **FAIL** — Phase 1 convergence is mostly present, but the live certification harness still has material false-pass gaps in scope/lifecycle evidence gates. These should be fixed before PR because findings are in-scope certification work orders.

## Convergence matrix check

- Pi structural base: **present** — cert harness, planning packet, local/echo validation docs are present.
- Codex gate: typed `PreparedTeamStep.leadOnly`: **present** (`engine/team-execution.ts:63-64`, `:227-284`).
- Codex gate: worker-spawn rejection: **present but narrow** (`scripts/certify-live-swarm:285-300`).
- Codex gate: non-synthesis `CERTIFICATION_CONTRACT` leak gate: **present** (`scripts/certify-live-swarm:165-180`, `:302-303`; prompt guard in `agents/teams/chains.yaml:255-291`).
- Codex gate: parser false-ready regression: **present** (`scripts/certify-live-swarm-test`, readiness/contract negative fixtures).
- Codex gate: lead prompt guard: **present** (`engine/team-execution.ts:239-246`, `agents/teams/chains.yaml:255-291`).
- Claude pipefail/exit-code fixes: **present** (`scripts/certify-live-swarm:157-162`, `:327-333`).

## Findings

### P3 / Medium — Live lead lifecycle gate counts any five `*-lead` completions, not the five required review perspectives

- Evidence: `scripts/certify-live-swarm:281-283` computes `lead_count` as a unique count of any `agent.end`/`agent_done` whose `agent_id` ends in `-lead`; it only checks `>= 5`.
- Why it matters: A live certification trace can pass the lifecycle gate with five duplicate/wrong/non-canonical leads while missing Security, Adversarial, Domain, etc. This directly weakens the Phase 1 lifecycle evidence guarantee the PR is meant to add.
- Reproduction/reasoning: A trace containing `pi-correctness-lead`, `pi-quality-lead`, `pi-planning-lead`, `pi-engineering-lead`, and `pi-validation-lead` would satisfy the current count even though three canonical swarm-review perspectives are absent.
- Blocks PR: **Yes**. Fix by checking the explicit required set: Correctness Review, Adversarial Review, Quality Review, Security Review, and Domain Review, preferably by normalized team name and/or exact expected lead IDs, with a regression fixture for “five leads but missing canonical perspective”.

### P3 / Medium — Fixture scope gate does not reject repo-source reads during fixture-only certification

- Evidence: `scripts/certify-live-swarm:308-313` rejects previous `/mae-cert.*` directories and sibling fixture reads, but there is no equivalent gate for tool calls against `$root` / repository source. The prompts in `scripts/certify-live-swarm:356-358` explicitly say not to inspect repo source.
- Why it matters: A live cert agent can satisfy or confuse certification by reading the implementation under test instead of only the isolated clean/seeded/failing fixture. That reintroduces a false-pass/false-fail path for the certification harness.
- Reproduction/reasoning: In live Pi mode, a trace with a `tool.call.args_preview` pointing to `$root/scripts/certify-live-swarm` or `$root/engine/...` would not match either current `drift_count` or `wrong_fixture_count`, so `require_trace_health` would still accept it.
- Blocks PR: **Yes**. Fix by rejecting tool calls under the repo root during fixture-only runs except the CLI invocation itself, and add a regression fixture for “repo-source read during fixture cert fails”.

## Perspective synthesis

- Correctness: Lead-only execution and synthesis contract wiring are implemented, but canonical lead coverage is under-specified.
- Adversarial/false-pass: The two findings above are false-pass risks in the certification harness.
- Quality/maintainability: Planning docs are consistent; scripts remain bash-heavy but targeted and covered by local tests.
- Security/safety: Read-only prompt/tool constraints are present; no secret handling issue found in the reviewed diff.
- Domain/MAE lifecycle certification: Phase 1 evidence gates are materially improved, but lifecycle and scope validation must be exact before PR.

## Verification run during review

- `scripts/certify-live-swarm-test` — pass, 34 checks.
- `bun test engine/team-execution.test.ts` — pass, 24 tests.
- `just check` — pass (`bunx tsc --noEmit`).
- `bun test` — pass, 556 pass / 1 skip.

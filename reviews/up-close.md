## Review
- Correct: `agents/teams/chains.yaml` parses through the project loader: `bun -e 'import { loadChains } from "./engine/config"; ...'` returned `13 5`. The changed `read_only: true` fields are valid YAML and align with existing `ParallelTeamStep.read_only` propagation tested in `engine/team-execution.test.ts`.
- Correct: Relevant tests passed: `bun test engine/chain-validator.test.ts engine/chain-runner.test.ts engine/team-execution.test.ts` => 55 pass, 0 fail.
- Correct: `scripts/certify-live-swarm` is shellcheck-clean in this environment: `shellcheck scripts/certify-live-swarm` produced no diagnostics.
- Correct: Artifact cleanup is safer than before: `scripts/certify-live-swarm:43-50` preserves artifacts on failure and deletes only after `certification_done=1`, unless `MAE_CERT_KEEP_ARTIFACTS=1`.
- Correct: The isolated `MAE_TRACE_DIR="$trace_dir"` in `scripts/certify-live-swarm:109` avoids accidentally certifying against an old global trace.

- Blocker: `scripts/certify-live-swarm:65-68` has brittle seeded-evidence regex. In GNU/BSD `grep -E`, `[\n]` is not a newline escape; `[^\n]*` means “not backslash or the letter n”. A normal finding like `P1 security finding: command injection` contains `n` before `command injection` and can false-fail even though the report is correct. Suggested minimal fix: replace the grep with an `awk` line-oriented lowercase check, e.g. require the line to contain `(p0|p1)` and one of `command injection`, `exec(`, `child_process`, `nslookup`, without using `[^\n]`.

- Blocker: `scripts/certify-live-swarm:70-78` can false-pass readiness failures. The skip rule at line 74 skips the whole line if it contains `not certification ready` or `lacks the required readiness marker`, even if the same line also contains an affirmative readiness marker. Example: `not certification ready; CERTIFICATION_READY` is ignored and the function exits non-match. Suggested minimal fix: make the negative exceptions apply only to lines that do not also contain `CERTIFICATION_READY`, or check exact positive markers first and then whitelist only tightly anchored negative phrases.

- Note: `scripts/certify-live-swarm:86-98` falls back to CLI stdout when no `pi-orchestrator-output-*.txt` artifact is found. That is useful for diagnostics, but for `--live-pi` it can blur whether the script certified the actual Pi review report or just wrapper output. Suggested minimal fix: when `adapter=pi`, require the artifact path to exist and fail if it does not; keep fallback only for echo smoke.

- Note: `agents/teams/chains.yaml:283-294` relaxed the `swarm-review` till_done gates substantially. This likely explains/addresses the live Pi failure if the actual Pi report used unified report wording rather than the old exact `REVIEW_REPORT|Unified Swarm Review|Scope...Verdict` form. However, the current gates can pass on broad phrases like `PASS`, `VERDICT`, `five canonical perspectives`, and `Unified Swarm Synthesis` without proving five schema blocks were emitted. Minimal fix: keep the broader accepted headers, but still require explicit evidence fields (`SCOPE`, `COMMANDS_RUN`, `FINDINGS`, `BLOCKERS`, `VERDICT`) or one `REVIEW_REPORT:` per role when certifying live review quality.

- Note: `scripts/certify-live-swarm:55-63` intentionally avoids failing on clean reports that say “No P0/P1”. It still misses blocker wording where severity follows the noun, e.g. `Finding: P1 command injection` or `Blocker - P0 unsafe exec`, because the regex requires severity first. Suggested minimal fix: add the inverse pattern `(finding|blocker|fail|...)[^[:alnum:]]+(P0|P1|critical|high)`.

- Note: `plan.md` and `progress.md` were requested but are absent at the repo root, so I could not verify the stated intent from those files.

Verification to run next:
1. Add/execute small shell fixture checks for `has_seeded_command_injection_evidence`, `has_actual_blocker`, and `marks_certification_ready` covering the false-pass/false-fail examples above.
2. Run `scripts/certify-live-swarm` with echo against a running dashboard.
3. Run `MAE_CERT_KEEP_ARTIFACTS=1 scripts/certify-live-swarm --live-pi --dashboard-url <actual-dashboard>` and confirm the seeded/failing decisions are based on `pi-orchestrator-output-*.txt`, not fallback stdout.

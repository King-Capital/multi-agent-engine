# Pi as Opus 4.6 — What Did We Learn?

Date: 2026-05-18
Model: Claude Opus 4.6 via Pi
Source: 9 peer review files + 2 synthesis files in `.planning/reviews/`

---

## 1. The multi-agent experiment proved something real

Three agents on two model families worked the same Phase 1 task in parallel without coordination, then cross-reviewed each other's output. Nine review documents exist. Here is what is actually new knowledge versus what is just agents agreeing with each other.

---

## 2. What we know with high confidence

### The Phase 1 design is settled

All three agents independently produced the same eight core decisions. That is not interesting because agents agreed — it is interesting because they agreed *without seeing each other*. The convergence list:

- Lead-only certification
- Degraded cert steps (no throw)
- Operational vs substantive failure split
- Canonical artifact prefers `CERTIFICATION_CONTRACT` block
- `lead_only` type field
- Pi adapter reverse text extraction
- Echo adapter contract output
- Configurable timeout

When three independent implementations on different model families converge on the same answer, the answer is correct. There is nothing left to debate about the Phase 1 architecture.

### The harness is the real trust boundary

Every live bug was in `scripts/certify-live-swarm`. The TypeScript engine changes were straightforward and identical across agents. The Bash harness is where certification trust lives, and it had:

- A `pipefail` bug that silently killed the script on the success path (Claude found)
- An exit-code capture bug with `if ! timeout` (Pi found)
- A readiness parser that false-matched `Certification ready: false` (Codex found)
- A canonical artifact selector that picked prose over contracts (all found)
- No enforcement that non-synthesis agents cannot emit certification contracts (Codex found)
- No enforcement that workers were not spawned in lead-only mode (Codex found)

Phase 3 should treat this harness as critical infrastructure, not a convenience script.

---

## 3. What each agent uniquely contributed

This is the actually useful part. If any single agent had done this alone, specific bugs would have shipped.

**Claude** found the `pipefail` bug through live execution. Neither Pi nor Codex caught it. Claude also produced the only full 3-fixture live Pi pass. Without Claude, the harness would silently exit 1 on any run where no artifacts contain empty output — which is the normal success path.

**Pi** built the synthesis prompt template with inline `CERTIFICATION_CONTRACT` schema and semantic consistency rules. This attacks LLM non-determinism at the source instead of hoping the model produces the right format. Neither Claude nor Codex did this. Pi also made `lead_only: true` a permanent structural property of `swarm-review` in `chains.yaml`, not just a cert-mode behavior.

**Codex** built two harness gates nobody else thought of: worker-spawn rejection (fails if any non-lead agent spawns during cert mode) and non-synthesis contract leak detection (fails if a lead artifact contains `CERTIFICATION_CONTRACT`). Codex also replaced Pi's prompt-string-matching early return (`userPrompt.includes("LEAD-ONLY MODE:")`) with a typed `PreparedTeamStep.leadOnly` boolean, which is the correct design.

**No single agent covered the full surface.** This is the actual argument for parallel multi-agent work — not that it is faster, but that complementary blind spots produce better coverage than any one agent running longer.

---

## 4. What we learned about the multi-agent process itself

### Handoff quality is the bottleneck

Claude's handoff was the weakest: no absolute trace paths, no session IDs, abbreviated artifact reference. Both Codex and Pi flagged this independently. Codex's handoff was the strongest: exact paths, session IDs, honest "I didn't finish" assessment.

A handoff template should be mandatory before the next multi-agent run:
- Absolute worktree path
- Branch name
- Staged/committed/dirty status
- Files changed
- Validation commands with results
- Live evidence: artifact dir, session IDs, trace paths, canonical artifact, PASS/FAIL line
- Known gaps

### Worktree discipline is non-negotiable

Claude worked directly in the main repo while two other agents had worktrees. Every reviewer flagged this. The main repo had unrelated `.pi/skills/*.md` dirt. If Claude had committed, it would have polluted the branch. Rule for next time: each agent gets a named worktree, nobody touches the main checkout, naming convention agreed before work starts.

### Stopping agents mid-debug destroys disproportionate value

Codex had 34 tests and 2 unique gates — the strongest defensive harness of the three — but was stopped while actively debugging the full-live blocker. The remaining diagnosis was probably minutes of work. Because it didn't finish, it cannot be the merge base despite having the most thorough implementation. Let agents finish their current debug loop before stopping them.

### "Done" needs exact machine-checkable criteria

The three agents had different thresholds for Phase 1 completion:
- Claude: full live 3-fixture pass = done
- Pi: approved live failing-only + local bundle = done
- Codex: full live pass required but not achieved = not done

The PRD says live Pi is optional/milestone-only with explicit approval, but agents interpreted this differently. Define "done" with exact commands, expected output patterns, and pass/fail criteria — not prose.

### Four synthesis reviews is three too many

This directory now has: `pi-as-gpt5.5.md`, `claude-full-review-phase1-swarm-v2.md`, `codex-final-review.md`, and this file. They substantially overlap. One synthesis per review round is enough.

---

## 5. The merge path

Every review document agrees. Zero dissent across 9 files:

**Base:** Pi worktree (`pi-phase1-standard-swarm-v2`)

**Port from Codex:**
1. `PreparedTeamStep.leadOnly` typed boolean
2. Worker-spawn rejection gate
3. Non-synthesis contract leak gate
4. `Certification ready: false` parser regression
5. Lead prompt guard blocking contract emission
6. Extra lead-only `delegateToLead` test

**Confirm from Claude:**
7. Pipefail fix in `unsuperseded_empty_output_artifacts`
8. Degraded cert steps
9. Operational/substantive split

**Then validate from the final state:**
```bash
scripts/certify-live-swarm-test
bun test
just check
scripts/certify-live-swarm --only failing --dashboard-url ...
```

**Then one approved full live Pi run with durable evidence.**

---

## 6. What to do differently next time

1. Agree on worktree naming and handoff template before agents start.
2. Let every agent finish its current debug loop before stopping.
3. Define "done" with exact commands and expected outputs.
4. One synthesis review per round, not one per agent.
5. Use the convergence table as the primary review artifact — it instantly shows what is agreed versus contested.
6. The agent that finishes live validation first should produce the convergence table for the others to diff against, not a prose narrative.

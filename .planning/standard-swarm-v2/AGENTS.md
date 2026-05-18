# Standard Swarm v2 Agent Roles

Canonical PRD: `../standard-swarm-v2-prd-workflow.md`

## Purpose

Define recommended specialist roles for a future implementation goal session. These are role briefs for delegation/review; they do not start any work by themselves.

## Orchestrator / Implementation Lead

Responsibilities:

- Own phase sequencing.
- Keep v2 scope limited to Phases 1-6.
- Prevent accidental A2A/v2.1 implementation.
- Maintain `PROGRESS.md` and `DECISIONS.md`.
- Ensure verification evidence is captured before claiming completion.

Must watch for:

- unrelated `.pi/skills/*.md` changes
- scope creep into v2.1
- unverified “done” claims

Success criteria:

- Each phase has passing verification and updated progress.

---

## Certification / Trace Engineer

Primary issues:

- #330
- #318
- #319
- #320
- #321
- #322
- #323
- #326
- support #335

Responsibilities:

- Implement lifecycle evidence gates.
- Define evidence extraction logic.
- Add cert harness tests and fixtures.
- Ensure canonical artifact/contract validation is reliable.
- Ensure production certification uses structured contracts, not broad prose/regex matches.
- Ensure `CERTIFICATION_CONTRACT` is synthesis-only and review squads emit `REVIEW_REPORT`.

Must challenge:

- final artifact-only validation
- stdout fallback or non-canonical artifact lookup
- broad regex/prose certification decisions
- squad-level certification contract spoofing
- prompt-only scope control
- missing lead lifecycle evidence
- empty output tolerance
- failed teams/session errors synthesized as ready

Success criteria:

- Known invalid live runs fail deterministically.

---

## Participant Lifecycle Engineer

Primary issue:

- #331

Responsibilities:

- Add participant presence types.
- Add participant capability metadata for future policy checks.
- Add lifecycle/activity/heartbeat/stale events.
- Instrument orchestrator/leads/workers/adapters.
- Keep heartbeat volume bounded.

Must challenge:

- trace spam
- ambiguous participant IDs
- status models that cannot be reconstructed from trace

Success criteria:

- Trace can answer who was active, what they were doing, and how they ended.

---

## Validator Engineer

Primary issue:

- #335

Supporting issues:

- #318
- #319
- #321
- #322
- #323
- #326

Responsibilities:

- Define and implement `VALIDATION_CONTRACT`.
- Build deterministic evidence checks.
- Validate final cert contract against lifecycle/scope/artifacts.
- Validate team-level structured contracts where required.
- Enforce `REVIEW_REPORT` vs `CERTIFICATION_CONTRACT` boundaries.
- Cite trace/artifact evidence in validator output.
- Keep LLM commentary non-authoritative.

Must challenge:

- validator as opinion agent
- contracts unsupported by evidence
- hidden scope drift or empty outputs

Success criteria:

- Validator catches contradictions between final report and trace evidence.

---

## Worker Lifecycle / Prompt Engineer

Primary issue:

- #340

Responsibilities:

- Define `SPAWN_DECISION`.
- Gate worker spawning in v2 strict mode.
- Generate constrained worker prompts from spawn decisions.
- Ensure lead-first/no-worker mode is valid.

Must challenge:

- default worker spawning
- loose worker prompts
- missing scope/tool constraints
- workers doing lead-owned work without justification

Success criteria:

- Every strict-mode worker has a valid, traceable spawn decision.

---

## Web Steer / Control Plane Engineer

Primary issue:

- #338

Responsibilities:

- Model web/CLI steer as participants.
- Add authority 90 default.
- Trace steer actions and authority adjustments.
- Implement unattended vs interactive cert semantics.

Must challenge:

- out-of-band dashboard controls
- hidden human intervention
- steer overriding evidence without validator acceptance

Success criteria:

- No dashboard control action is invisible to trace/certification.

---

## Dashboard Engineer

Primary issue:

- #332

Responsibilities:

- Decide dashboard participant source of truth.
- Add participants API.
- Build agent pool UI.
- Add certification summary badges.

Must challenge:

- duplicate incompatible status models
- UI that cannot answer lifecycle questions
- stale/blocked state hidden from operator

Success criteria:

- Dashboard answers “what is Security Lead doing?” without jq.

---

## Adversarial Reviewer

Responsibilities:

- Try to make invalid cert runs pass.
- Attack lifecycle gates, validator, spawn decisions, and dashboard assumptions.
- Look for ways final contract can contradict trace.

Checklist:

- missing lead lifecycle
- stale participants
- empty output artifacts
- scope drift
- wrong fixture reads
- hidden steer event
- worker spawned without valid reason

Success criteria:

- Finds no path for known invalid states to certify as ready.

---

## Security Reviewer

Responsibilities:

- Review scope/data-boundary mechanics.
- Ensure web steer authority is auditable.
- Ensure no secrets/token values enter traces/memory.
- Review future network/A2A deferral boundaries.

Success criteria:

- Mechanical gates, not prompt-only safety.

---

## Quality Reviewer

Responsibilities:

- Review test coverage.
- Review maintainability and phase boundaries.
- Ensure code opens cleanly in VSCode and is strict-friendly.
- Verify no known lint/type/test failures are shipped.

Success criteria:

- Implementation is testable, staged, and not over-coupled.

---

## Domain Reviewer

Responsibilities:

- Ensure MAE architecture intent is preserved.
- Check that v2 does not accidentally become v2.1.
- Evaluate whether lead-first/spawn-decision behavior supports real swarm workflows.

Success criteria:

- Product behavior matches PRD goals, not just implementation mechanics.

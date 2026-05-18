# Standard Swarm v2 Execution Packet

Canonical PRD:

- `../standard-swarm-v2-prd-workflow.md`

Supporting design note:

- `../standard-swarm-v2-flat-leads.md`

Purpose:

This folder turns the PRD into execution-ready planning artifacts for a future goal session. It is planning only; do not start implementation from this document unless explicitly instructed.

Files:

- `EXECUTION_WORKFLOW.md` — per-phase Scope → Tasks → Implementation → Validate → Fixes loop
- `TASKS.md` — ordered task list for v2 Phases 1-6
- `AGENTS.md` — recommended specialist roles and review responsibilities
- `PROGRESS.md` — live progress tracker template
- `VALIDATION.md` — acceptance/verification matrix
- `DECISIONS.md` — implementation decision log template

Scope boundary:

Standard Swarm v2 implementation scope is PRD Phases 1-6 only:

1. lifecycle evidence gates
2. participant presence/heartbeat
3. deterministic validator
4. structured spawn decisions
5. web/CLI steer as high-authority participants
6. dashboard agent pool

Deferred v2.1/RFC scope:

- session-local A2A primitives
- scoped sub-buses
- authority-weighted peer conflict resolution
- peer challenge phase
- cross-device HTTP/SSE agent hub

Certification foundation preflight:

Before Phase 1 implementation, triage and map older certification-foundation issues into the v2 work:

- #288
- #318
- #319
- #320
- #321
- #322
- #323
- #326

These issues describe known false-pass/false-fail certification risks and must not be treated as unrelated backlog.

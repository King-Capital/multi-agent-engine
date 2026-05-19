# Standard Swarm v2 Structured Agent Workflow

Canonical PRD: `../standard-swarm-v2-prd-workflow.md`

This doc adapts the structured workflow pattern shown in the reference image:

1. Scope
2. Tasks
3. Implementation
4. Lint / Type / Test
5. Fixes

Use this loop for **each phase** and for any non-trivial task inside a phase.

## Docs-as-source-of-truth rule

Use the planning docs as the default basis for implementation decisions:

- Read the relevant PRD/task/validation docs before changing code.
- Keep docs updated as implementation changes scope, behavior, or acceptance criteria.
- Update repo READMEs, `docs/`, `specs/`, and nearby module docs when commands, schemas, traces, config, validation, dashboards, or operator expectations change.
- Do not rethink or rewrite working parts of MAE without evidence.
- Any deviation from the docs requires a `DECISIONS.md` entry before or in the same commit as the code change.
- If code reality contradicts the docs, inspect the code, update the docs with the discovered fact, and then proceed.
- Do not mark a task or phase complete while documentation is stale or incomplete.

## Regression rule

Every observed certification/orchestration failure that reaches manual debugging must become a regression fixture/test before the fix is considered complete.

Examples:

- missing lead lifecycle
- empty output artifact
- scope drift into old `mae-cert.*`
- wrong fixture read
- missing final contract field
- hidden steer event
- worker spawned without valid decision

## Core workflow

```text
1. Scope
   Define boundaries, files, issue, success criteria, non-goals.

2. Tasks
   Break work into small ordered steps with acceptance criteria.

3. Implementation
   Make the minimal focused code/doc/test changes.

4. Lint / Type / Test
   Run targeted checks first, then phase-level local verification.

5. Fixes
   Resolve failures, update tests/docs, rerun validation, record evidence.
```

## Per-phase workflow checklist

Every phase must complete this checklist before being marked complete in `PROGRESS.md`.

Phase 0 gate:

Before Phase 1 starts, triage certification-foundation issues #288, #318, #319, #320, #321, #322, #323, and #326. Record whether each is already resolved, a Phase 1 prerequisite, a Phase 3 prerequisite, or explicitly deferred with reason. Do not claim Phase 1 completeness while any untriaged P0/P1 certification-foundation issue remains open.

### 1. Scope

Before scoping, read the relevant docs:

- canonical PRD
- this workflow doc
- `TASKS.md`
- `VALIDATION.md`
- existing `DECISIONS.md`

Record:

- phase number and issue(s)
- exact objective
- in-scope files/modules
- out-of-scope items
- dependencies
- acceptance criteria
- validation commands planned

Template:

```md
## Phase N scope

Issue(s): #...
Objective:
In scope:
Out of scope:
Dependencies:
Acceptance criteria:
Planned validation:
```

Hard rule:

If scope expands into v2.1 items, stop and record a decision. Do not silently implement A2A/sub-buses/peer challenge in v2.

### 2. Tasks

Break scope into small tasks before editing code.

Template:

```md
- [ ] Task N.1 — name
  - objective:
  - likely files:
  - acceptance:
  - targeted validation:
```

Hard rule:

No task is complete without validation evidence.

### 3. Implementation

Implementation rules:

- keep changes narrow
- add/adjust tests with code changes
- avoid unrelated `.pi/skills/*.md` dirt
- preserve legacy/current swarm behavior unless strict/v2 mode is explicitly enabled
- prefer deterministic evidence checks before LLM interpretation

Hard rule:

Do not move to the next phase if current phase has failing required checks.

### 4. Lint / Type / Test

Use practical validation, not full live swarms.

#### During a task

Run targeted checks:

```bash
bun test engine/<changed-module>.test.ts
scripts/certify-live-swarm-test
```

Use whichever targeted command matches the changed area.

#### At phase boundary

Run local phase/PR bundle:

```bash
scripts/certify-live-swarm-test
bun test
just check
```

When dashboard is reachable and cert harness was touched:

```bash
scripts/certify-live-swarm --only failing --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"
```

#### Dashboard/UI phases

Discover and run the smallest reliable dashboard checks available in this repo. Expected categories:

- dashboard backend tests/build
- dashboard-next tests/build/lint if available
- manual/browser verification only for visible UI changes

#### Live Pi policy

Do not run live Pi swarms as routine validation. Live Pi runs require explicit user approval and are milestone-only.

### 5. Fixes

If validation fails:

1. record failure in `PROGRESS.md`
2. add or update a regression fixture/test for the failure
3. fix the in-scope issue
4. rerun targeted checks
5. rerun phase-level local bundle if phase boundary
6. update docs/tests if behavior changed
7. only then mark task/phase complete

Hard rule:

Do not classify required lint/type/test/build failures as tech debt.

## Phase-specific workflow cards

### Phase 1 — Lifecycle evidence gates

1. Scope:
   - certify bad lifecycle evidence fails closed
   - no participant presence dependency yet
   - absorb open certification-foundation issues that affect contract parsing, canonical artifact lookup, failed teams/session errors, and squad/final output boundaries
2. Tasks:
   - evidence schema
   - lead lifecycle gate
   - empty output gate
   - failed team/session gate
   - scope drift/wrong fixture gates
   - canonical contract gate
   - structured contract validation and parser false-pass fixtures
   - synthesis-only `CERTIFICATION_CONTRACT` boundary
3. Implementation:
   - keep bash harness practical or add focused TS helper if needed
4. Validate:
   - cert harness tests
   - `scripts/certify-live-swarm-test`
   - `bun test`
   - `just check`
   - echo failing-only smoke if dashboard reachable
5. Fixes:
   - add fixtures for any missed invalid state

### Phase 2 — Participant presence/heartbeat

1. Scope:
   - trace-visible participants and bounded heartbeat/activity
2. Tasks:
   - types
   - emitter helpers
   - instrumentation
   - participant capability metadata
   - stale policy
   - trace docs
3. Implementation:
   - avoid high-frequency heartbeat spam
4. Validate:
   - event/trace tests
   - targeted module tests
   - full local bundle
5. Fixes:
   - reduce volume if traces become noisy

### Phase 3 — Validator/verifier

1. Scope:
   - deterministic evidence validator, not opinion agent
2. Tasks:
   - validation contract
   - evidence checks
   - team-level structured contract validation
   - `REVIEW_REPORT` vs `CERTIFICATION_CONTRACT` boundary validation
   - strict cert integration
3. Implementation:
   - cite trace/artifact evidence
4. Validate:
   - validator contradiction tests
   - cert fixture tests
   - full local bundle
5. Fixes:
   - add new contradiction fixtures for any escaped bad state

### Phase 4 — Structured spawn decisions

1. Scope:
   - explicit worker spawn decisions and constrained prompts
2. Tasks:
   - schema
   - strict spawn gate
   - prompt generation
   - validator spawn checks
3. Implementation:
   - preserve legacy/current mode
4. Validate:
   - worker lifecycle tests
   - prompt snapshot tests
   - full local bundle
5. Fixes:
   - tighten prompt/schema if workers can drift

### Phase 5 — Web/CLI steer participants

1. Scope:
   - high-authority traceable steer events
2. Tasks:
   - participant kinds
   - authority 90 default
   - steer trace events
   - cert mode semantics
3. Implementation:
   - no invisible dashboard controls
4. Validate:
   - backend/API tests
   - trace tests
   - cert mode tests
   - full local bundle
5. Fixes:
   - ensure steer cannot hide evidence failures

### Phase 6 — Dashboard agent pool

1. Scope:
   - participant status visibility in dashboard
2. Tasks:
   - source-of-truth decision
   - participants API
   - agent pool UI
   - cert summary badges
3. Implementation:
   - avoid duplicate status model
4. Validate:
   - backend API tests
   - component/build checks if available
   - manual/browser verification for visible UI
   - full local bundle
5. Fixes:
   - simplify to backend evidence summary if UI complexity grows

## Progress update format

At the end of each task, update `PROGRESS.md` with:

```md
### Task update

Task:
Status: complete | blocked | in-progress
Files changed:
Targeted validation:
Phase validation if run:
Failures found:
Fixes applied:
Next task:
```

## Final rule

The workflow is only complete when every scoped phase has passed:

- task-level targeted validation
- phase-level local verification bundle
- documented fixes for all failures
- progress evidence
- no unapproved v2.1 scope creep

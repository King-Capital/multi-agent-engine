# Standard Swarm v2: Flat Leads, Bounded Communication, Specialist Workers

## Context

This note captures the MAE architecture insight from the Pi-to-Pi video analysis and subsequent planning discussion.

The proposed direction is not a replacement for MAE's standard swarm. It is closer to an evolution of the standard swarm pattern that has already worked well: keep the strong specialist lead perspectives, but let leads communicate in a bounded flat architecture before final synthesis.

## Core hypothesis

MAE can become better, faster, and more efficient by shifting from default lead→many-worker spawning toward:

- strong specialist leads doing more work directly
- bounded lead-to-lead communication
- workers spawned only for distinct specialist needs
- validator/verifier checking claims against trace/artifact evidence
- dashboard showing all participants and message state

Extra workers should not be default capacity. They should be specialist escalation.

## Target architecture

```text
Standard Swarm v2

5 Lead Agents:
  - Correctness
  - Security
  - Adversarial
  - Quality
  - Domain

Default:
  Leads do work directly.

Communication:
  Bounded lead-to-lead bus.

Workers:
  Spawned only by explicit specialist decision.

Validator:
  Checks claims against trace/artifacts.

Dashboard:
  Shows participants, messages, stale state, challenges.

Remote:
  Optional later for prod/dev/sandbox/special machines.
```

## Why this extends standard swarm

The standard swarm is effective because the perspectives are distinct. Flat lead communication extends that by letting those perspectives interact while work is happening instead of only after final reports are produced.

Example:

1. Security finds an auth boundary risk.
2. Correctness checks whether it is a real reachable code path.
3. Domain checks whether it matters in production context.
4. Adversarial tries to exploit or invalidate it.
5. Quality checks whether evidence is complete.
6. Validator checks that the final claim matches trace/artifact evidence.

This should produce better conclusions than five isolated reports plus late synthesis.

## Value adds

### 1. More work at once without flooding the system

Flat lead communication lets leads coordinate in parallel while avoiding the noise of default worker swarms.

### 2. Better synthesis quality

Synthesis currently has to reconcile independent reports after the fact. With lead communication:

- conflicts are resolved earlier
- weak claims get challenged earlier
- duplicate findings merge earlier
- final synthesis receives cleaner defended contracts

### 3. Lower cost than huge worker swarms

Keeping five strong leads but avoiding default workers reduces:

- token spend
- latency
- empty-output risk
- noisy artifacts
- scope drift
- lifecycle gates to satisfy

### 4. Remote/special environment agents later

A2A across machines could unlock:

- prod-side read-only/redacted agent
- dev-side reproducer agent
- GPU-machine agent
- sandbox agent
- OS-specific agents
- browser/visual QA agent
- database-near agent
- infra-near agent

The value is not just more agents on the same repo; it is specialized environment access.

### 5. Data-boundary workflows

The prod/dev pattern from the video maps well to MAE:

```text
Prod Agent: can inspect prod-like data, cannot leak PII
Dev Agent: receives redacted slice, reproduces issue locally
Validator: verifies redaction happened
```

### 6. Better live observability

If every participant is on the bus, the dashboard can show:

- who is active
- who is stale
- who is waiting on whom
- who challenged whom
- unresolved questions
- message graph
- bottlenecks

### 7. Reviewer accountability

Flat lead communication creates audit trails:

```text
Security claimed X.
Adversarial challenged X.
Security provided evidence Y.
Domain downgraded severity to P2.
Validator accepted/rejected the chain.
```

### 8. Reusable expert nodes

Future MAE could expose always-available specialist participants:

- Vaultwarden/secrets reference agent
- infra/proxmox agent
- DB agent
- browser QA agent
- docs/research agent
- validator agent
- release manager agent

### 9. Model diversity

Different leads can run different models and challenge each other. The value is independent reasoning loops communicating, not just parallelism.

### 10. Stronger certification evidence

Production certification can prove:

- all leads participated
- peer challenge happened or was explicitly skipped
- unresolved challenges are zero
- validator checked claims
- no stale participants
- no scope drift
- final contract matches trace

## Drawbacks and mitigations

### 1. Bus noise

If every worker and lead can chat freely, the bus becomes loud and less useful.

Mitigation:

```yaml
bus_policy:
  default_participants: leads_only
  workers_can_peer_message: false
  max_messages_per_lead: 3
  max_rounds: 1
```

### 2. Loops

Challenge/response cycles can run forever.

Mitigation:

- max hops
- max rounds
- message TTL
- unresolved -> validator decision
- no recursive send unless explicitly allowed

### 3. Cost creep

Peer messages add token cost even without workers.

Mitigation:

- per-session message budget
- per-lead message budget
- cost visible in dashboard
- certification records communication cost

### 4. Consensus can water down findings

Flat teams may over-negotiate and incorrectly downgrade severity.

Mitigation:

- adversarial/security findings cannot be downgraded without evidence
- validator checks downgrades
- minority reports are preserved
- unresolved P0/P1 blocks pass

### 5. Harder deterministic certification

More communication adds nondeterminism.

Mitigation:

- certification mode uses a bounded fixed challenge matrix
- one challenge round
- required structured contracts
- no arbitrary free chat

### 6. Security/data leakage

Remote agents create data-boundary risk.

Mitigation:

- network A2A disabled by default
- session/project scoping
- redaction policy
- no secrets in messages
- Vaultwarden references only
- validator checks data-boundary claims

### 7. More dashboard/backend complexity

Agent pool, message graph, heartbeats, and stale detection add complexity.

Mitigation: build in layers.

1. participant presence
2. dashboard pool
3. local A2A
4. peer challenge
5. remote A2A

## Worker spawning policy

Workers should be spawned only when a lead can justify a distinct specialist need.

Suggested spawn contract:

```yaml
SPAWN_DECISION:
need_worker: true | false
reason: distinct_specialist_needed | parallel_coverage_needed | evidence_verification | no_worker_needed
why_lead_cannot_do_it: string
specialty_required: string
scope: exact files/dirs/tools
expected_output_schema: string
timeout_ms: number
```

If no distinct specialist is required:

```yaml
SPAWN_DECISION:
need_worker: false
reason: lead_can_complete_scope
```

## Communication policy

Initial production-safe policy:

```yaml
communication_policy:
  default_participants: leads_only
  workers_can_send_peer_messages: false
  lead_can_spawn_worker: explicit_decision_only
  max_peer_messages_per_lead: 3
  max_challenge_rounds: 1
  require_response_schema: true
  allow_web_steer_messages: false
```

## Certification mode comparison

Before changing defaults, compare:

1. Current mode: leads + default workers.
2. Lead-only flat mode: five leads + peer challenge.
3. Lead-first specialist mode: leads + workers only if justified.

Measure:

- correctness of findings
- cost
- latency
- empty outputs
- scope drift
- missing lifecycle events
- final contract validity
- validator failures
- bus message count

Expected winner: **lead-first specialist mode**.

## Bottom line

The likely winning MAE architecture is:

> standard swarm roles + bounded lead communication + specialist workers on demand + validator + lifecycle gates.

This should preserve what already works about standard swarm while making MAE faster, cheaper, more auditable, and better suited to distributed real-world engineering.

---

## Addendum: Authority-Weighted Flat Leads and Scoped Sub-Buses

This section refines Standard Swarm v2 with an authority policy. It is additive to the original design, not a replacement. The original design defines the execution shape; this addendum defines how conflicts, human steering, lead overload, and worker communication should be governed.

## Why authority is needed

Flat lead communication improves review quality, but a purely flat debate can become nondeterministic. Authority levels provide a deterministic conflict-resolution mechanism without returning to a single all-powerful orchestrator.

Authority should not replace evidence. It should decide which claims require stronger rebuttal and how conflicts are escalated.

## Default authority model

Suggested initial defaults:

```yaml
authority:
  web-steer: 90
  cli-steer: 90
  Security Review: 70
  Adversarial Review: 70
  Correctness Review: 60
  Quality Review: 60
  Domain Review: 60
  workers: 40
```

Meaning:

- Web/CLI steer has the highest directional authority because it represents human/operator control.
- Security and Adversarial have elevated authority because false negatives in those perspectives are high risk.
- Correctness, Quality, and Domain are strong peer leads but do not casually override security/adversarial blockers.
- Workers provide evidence to their lead; they do not normally vote on the main lead bus.

## Domain-specific authority

A single global number is useful as a start, but domain-specific authority is more precise.

Example:

```yaml
domain_authority:
  Security Review:
    security: 85
    adversarial: 70
    correctness: 55
    domain: 50
    quality: 55
  Adversarial Review:
    adversarial: 85
    security: 70
    correctness: 60
    domain: 50
    quality: 50
  Domain Review:
    domain: 85
    correctness: 60
    security: 55
    adversarial: 55
    quality: 60
  Correctness Review:
    correctness: 80
    quality: 65
    security: 55
    adversarial: 55
    domain: 60
  Quality Review:
    quality: 80
    correctness: 65
    security: 55
    adversarial: 55
    domain: 55
```

This prevents Security from dominating domain-only calls while preserving Security's authority over security claims.

## Web steer authority

Web steer messages should default to authority `90`.

Web steer can:

- pause/stop/resume a run
- redirect scope
- adjust lead authority
- approve escalation
- request additional specialist spawn
- force validator re-check
- mark a run interactive instead of unattended

But web steer cannot silently override evidence gates.

```yaml
web_steer_can_override:
  - priorities
  - scope
  - authority weights
  - stop_pause_resume
  - escalation decisions

web_steer_cannot_override_without_validator:
  - missing evidence
  - failed lifecycle gates
  - scope drift
  - empty outputs
  - invalid certification contract
```

Every web steer event must be traced:

```yaml
STEER_EVENT:
from: web-steer
authority: 90
action: adjust_authority
target: Domain Review
old_authority: 60
new_authority: 80
reason: "Compliance/domain context is decisive here"
certification_impact: interactive_run
```

Certification policy:

```yaml
certification_mode:
  unattended:
    allow_web_steer: false
    web_steer_events_allowed: 0
  interactive:
    allow_web_steer: true
    require_steer_trace: true
    validator_must_accept_steer_effects: true
```

## Conflict resolution policy

Authority is used to reduce unbounded debate and make certification deterministic.

```yaml
conflict_resolution:
  if_p0_or_p1_security_or_adversarial_claim:
    default: preserve_blocker
    downgrade_requires:
      - evidence_reference
      - higher_or_equal_authority_counterclaim
      - validator_acceptance
  tie_breaker_order:
    - higher_domain_authority
    - more_direct_evidence
    - validator_decision
```

Important rule:

> Authority decides who must be rebutted. Evidence decides what is true. Validator decides whether the evidence supports the final contract.

## Lead overload and scoped sub-buses

If a lead has too much initial scope, it may spawn a Sr. agent or workers. Those workers should communicate on a separate scoped sub-bus, not the main lead bus.

Architecture:

```text
Main Lead Bus:
  Correctness Lead
  Security Lead
  Adversarial Lead
  Quality Lead
  Domain Lead

Security Sub-Bus:
  Security Lead
  Sr Security Reviewer
  Auth Worker
  Dependency Worker
```

Rules:

- Workers do not talk on the main lead bus by default.
- Workers report to their owning lead or Sr. agent.
- Lead summarizes worker findings back to the main bus.
- Sub-bus has its own max messages, time, budget, and scope.
- Sub-bus activity is traceable and validator-visible.

## Spawn decision contract

Worker spawning requires an explicit contract.

```yaml
SPAWN_DECISION:
need_worker: true
spawn_type: sr_agent | worker_group | single_worker
reason: overloaded_scope | distinct_specialist_needed | evidence_verification
why_lead_cannot_do_it: "Requires dependency/CVE-specific review"
constraints:
  allowed_paths:
    - src/auth/**
    - package.json
    - bun.lock
  forbidden_paths:
    - .env
    - previous mae-cert dirs
  allowed_tools:
    - read
    - grep
  communication_bus: security-sub-bus
  can_message_main_bus: false
expected_output_schema: SECURITY_WORKER_FINDINGS
timeout_ms: 120000
```

No worker should be spawned merely because the team has worker slots available.

## Updated communication policy

```yaml
standard_swarm_v2:
  main_bus:
    participants: leads_only
    max_rounds: 1
    max_messages_per_lead: 3
    require_response_schema: true

  authority:
    default:
      web-steer: 90
      cli-steer: 90
      Security Review: 70
      Adversarial Review: 70
      Correctness Review: 60
      Quality Review: 60
      Domain Review: 60
      workers: 40
    user_adjustable: true
    adjustments_require_trace: true

  spawning:
    default: lead_owned_work
    allowed_when:
      - overloaded_scope
      - distinct_specialist_needed
      - evidence_verification
    sub_bus_required: true
    workers_can_message_main_bus: false

  validator:
    required: true
    validates:
      - authority_adjustments
      - conflict_resolution
      - worker_spawn_decisions
      - final_contract
      - lifecycle_evidence
```

## How this addresses the critical risks

### Bus noise

Main bus stays lead-only. Workers are isolated in scoped sub-buses.

### Loops

Authority, max rounds, max hops, and validator escalation prevent endless challenge cycles.

### Lead overload

Leads can spawn Sr. agents/workers when justified, but the spawn is constrained and auditable.

### Fake consensus

High-authority blockers cannot be negotiated away without evidence and validator acceptance.

### Certification nondeterminism

Authority rules, fixed challenge matrix, response schemas, and validator checks make peer communication certifiable.

### Human/operator control

Web steer has high authority but is traceable and certification-impacting. It can direct the run, but it cannot hide missing evidence.

## Updated bottom line

The refined winning architecture is:

> standard swarm roles + authority-weighted bounded lead communication + scoped sub-buses for justified specialist workers + high-authority traceable web steer + validator + lifecycle gates.

This is stronger than simple flat peer chat and safer than default worker-heavy swarms.

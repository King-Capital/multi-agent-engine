# Task Spec Template
#
# Standard job contract format for MAE agent tasks.
# Pattern from IndyDevDan's local agent-host control video.
# https://www.youtube.com/watch?v=LOazLNQnB80
#
# Every agent task should follow this structure.
# The lead fills this out, workers execute against it.

## Instructions

<!-- What the agent should do. Be specific about approach, not just outcome. -->

## Context

<!-- Relevant background: what happened before, why this matters, constraints. -->

## Tasks

<!-- Checklist format. Each item is independently verifiable. -->

- [ ] Task 1
- [ ] Task 2
- [ ] Task 3

## Deliverables

<!-- What the agent must produce. Concrete outputs, not vague descriptions. -->

- [ ] Deliverable 1 (e.g., "modified file X with Y change")
- [ ] Deliverable 2 (e.g., "test output showing all pass")

## Constraints

<!-- Time limit, scope boundaries, what NOT to touch. -->

- Time limit: 5 minutes (summarize and deliver if approaching)
- Scope: Only modify files in [specified paths]
- Do NOT: [explicitly forbidden actions]

## Proof of Work

<!-- Evidence the agent must capture to verify completion. -->

- [ ] Screenshot of final state (if UI work)
- [ ] Test output log
- [ ] Git diff of changes made

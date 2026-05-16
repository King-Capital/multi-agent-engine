---
description: Full code swarm review - correctness, adversarial, quality, security, domain
argument-hint: <diff-command-or-files>
chain: swarm-review
---

# Purpose

Run the canonical full code review swarm for a PR, branch diff, or file set. Five distinct reviewer roles run in parallel: correctness, adversarial, quality, security, and domain specialist. The orchestrator synthesizes findings and resolves disagreements.

## Variables

TARGET: $1

## Instructions

- Five reviewer roles run in PARALLEL on the same code: correctness, adversarial, quality, security, domain
- Use the standard code-swarm model pair by default: Opus/`opus-nocache` and `gpt-5.5`
- Each role must return P0-P3 findings with evidence, file/line references, and smallest safe fixes
- Orchestrator synthesizes conflicting findings

## Workflow

1. Delegate in PARALLEL:
   - **Correctness Reviewer**: functional correctness, regressions, type/runtime safety
   - **Adversarial Reviewer**: break assumptions, hidden failure modes, brittle tests
   - **Quality Reviewer**: maintainability, simplicity, test quality, code hygiene
   - **Security Reviewer**: auth, injection, SSRF/path/process/network/secrets risks
   - **Domain Reviewer**: repo-specific business/operational/domain correctness

2. Orchestrator synthesizes:
   - Where reviewers agree → confirmed finding
   - Where reviewers disagree → investigate, pick the stronger argument
   - Final grade based on worst confirmed finding

## Report

- Confirmed findings: [list with severity]
- Disputed findings: [list with reviewer perspectives]
- Role-specific findings: [findings unique to one reviewer]
- Final grade: PERFECT / VERIFIED / PARTIAL / FEEDBACK / FAILED
- Total cost: [sum across all agents]

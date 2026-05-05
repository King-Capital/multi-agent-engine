---
description: Full SDLC workflow - plan, build, and review a task
argument-hint: <task-description>
chain: plan-build-review
---

# Purpose

Execute a complete development cycle: analyze the problem, produce a plan, implement it, and validate the result.

## Variables

TASK: $1

## Instructions

- The Orchestrator runs the plan-build-review chain
- Planning team scouts the codebase and produces an implementation plan
- Engineering team implements per the plan
- Validation team reviews with a different model family than the builder
- If validation finds issues, corrections route back to engineering (max 3 attempts)
- Final report includes: what was done, what was validated, final grade

## Workflow

1. Delegate to **Planning** team:
   - Scout the codebase for relevant files
   - Produce implementation plan: files to change, specific changes, risks
   - Write plan to session directory

2. Delegate to **Engineering** team:
   - Implement changes per the plan
   - Run tests and builds to verify
   - Report what was done with file paths and verification results

3. Delegate to **Validation** team:
   - Code review all changes (different model than builder)
   - Security review for OWASP/injection vulnerabilities
   - Grade: PERFECT / VERIFIED / PARTIAL / FEEDBACK / FAILED

4. For FEEDBACK or FAILED:
   - Route corrections back to **Engineering** team
   - Re-validate with **Validation** team
   - Max 3 correction cycles, then escalate to user

## Report

Produce a structured summary:
- Task completed: yes/no
- Files changed: [list]
- Grade: [final validation grade]
- Corrections applied: [count]
- Cost: [total session cost]

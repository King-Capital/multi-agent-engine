---
description: Red team attacks, blue team validates — sequential adversarial review
argument-hint: <diff-command-or-files>
chain: red-blue
---

# Purpose

Red team goes first — finds every vulnerability, challenges every assumption, tries to break the code. Then blue team evaluates: which red team findings are real, which are false positives?

## Variables

TARGET: $1

## Instructions

- Red team runs FIRST with full adversarial mindset
- Blue team runs SECOND with red team findings as input
- Blue team's job: validate or dispute each red team finding with deterministic evidence
- Cross-model: if red team used opus, blue team uses gemini (and vice versa)

## Workflow

1. Delegate to **Red Team**:
   - Adversarial review: assume the code is guilty
   - Security review: OWASP, injection, credential leaks
   - Output: attack vectors, challenged assumptions, missing coverage

2. Delegate to **Blue Team** (with red team output as $INPUT):
   - Correctness review: verify each red team claim with deterministic checks
   - Quality review: is the code maintainable regardless of red team findings?
   - For each red team finding: CONFIRMED, DISPUTED (with evidence), or INCONCLUSIVE

## Report

- Confirmed vulnerabilities: [red findings blue validated]
- Disputed: [red findings blue challenged, with evidence]
- Additional blue findings: [issues red team missed]
- False positive rate: [% of red findings that were wrong]
- Final grade: based on confirmed findings only

---
description: Full swarm review - red team + blue team in parallel
argument-hint: <diff-command-or-files>
chain: swarm-review
---

# Purpose

Run a full review swarm with competing perspectives. Red team finds vulnerabilities and challenges assumptions. Blue team verifies correctness and quality. Orchestrator synthesizes.

## Variables

TARGET: $1

## Instructions

- Red and Blue teams run in PARALLEL on the same code
- Different models on each team for cross-model validation
- Red team: adversarial + security (opus, find what's broken)
- Blue team: correctness + quality (gemini pro, verify what works)
- Orchestrator synthesizes conflicting findings

## Workflow

1. Delegate in PARALLEL:
   - **Red Team**: adversarial review + security review of $TARGET
   - **Blue Team**: correctness review + quality review of $TARGET

2. Orchestrator synthesizes:
   - Where Red and Blue agree → confirmed finding
   - Where they disagree → investigate, pick the stronger argument
   - Final grade based on worst confirmed finding

## Report

- Confirmed findings (both teams agree): [list with severity]
- Disputed findings (teams disagree): [list with both perspectives]
- Red team only: [findings Blue team missed]
- Blue team only: [findings Red team missed]
- Final grade: PERFECT / VERIFIED / PARTIAL / FEEDBACK / FAILED
- Total cost: [sum across all agents]

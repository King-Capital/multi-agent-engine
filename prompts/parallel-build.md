---
description: Build the same task with multiple model families, pick the best result
argument-hint: <task-description>
chain: parallel-build
---

# Purpose

Send the same task to multiple engineering teams running different models. Validate both results. Pick the winner.

## Variables

TASK: $1

## Instructions

- Orchestrator sends the SAME brief to Engineering and Engineering B
- Engineering uses Anthropic models (sonnet/opus)
- Engineering B uses Gemini models (pro/flash)
- Both build in parallel
- Validation team reviews both implementations
- Best result wins, other is discarded

## Workflow

1. Delegate to **Planning** team:
   - Quick scout and plan (shared by both engineering teams)

2. Delegate in PARALLEL:
   - **Engineering** team: implement using Anthropic models
   - **Engineering B** team: implement using Gemini models

3. Delegate to **Validation** team:
   - Review BOTH implementations
   - Grade each independently
   - Select the winner based on: correctness > quality > cost
   - Report which won and why

## Report

- Winner: [Engineering / Engineering B]
- Winner grade: [grade]
- Loser grade: [grade]
- Key difference: [what made the winner better]
- Cost comparison: [cost of each team]

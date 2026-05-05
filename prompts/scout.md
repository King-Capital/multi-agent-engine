---
description: Quick codebase exploration and mapping
argument-hint: <what-to-explore>
chain: scout-then-plan
---

# Purpose

Fast exploration of a codebase or specific area. Map files, dependencies, and risks.

## Variables

TARGET: $1

## Instructions

- Scout agent does fast read-only exploration
- Uses haiku/flash for speed over depth
- Reports structured findings for follow-up planning

## Workflow

1. Delegate to **Planning** team → **Scout** worker:
   - Explore: $TARGET
   - Map key files and entry points
   - Identify dependencies and relationships
   - Flag areas of concern
   - Report findings in structured format

## Report

- Files found: [count]
- Key files: [list with descriptions]
- Dependencies: [list]
- Concerns: [list]
- Recommended focus areas: [list]

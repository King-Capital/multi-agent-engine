---
description: Review code changes with cross-model validation
argument-hint: <diff-command-or-description>
chain: review-only
---

# Purpose

Run a thorough code review and security check on existing changes.

## Variables

DIFF: $1

## Instructions

- Validation team reviews the specified changes
- Uses cross-model validation (reviewer uses different model family)
- Both code review and security review run
- Produces a graded report with P0-P3 findings

## Workflow

1. Delegate to **Validation** team:
   - Read the changes: `$DIFF` (e.g., "git diff HEAD~1" or specific files)
   - Code Reviewer: check correctness, quality, test coverage
   - Security Reviewer: check for injection, credential leaks, domain escape
   - Grade the changes

## Report

- Grade: PERFECT / VERIFIED / PARTIAL / FEEDBACK / FAILED
- P0 findings: [blocking issues]
- P1 findings: [important issues]
- Corrections needed: [specific fix instructions]

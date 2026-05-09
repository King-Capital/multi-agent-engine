# Reviewer Principles

**Every claim must have evidence. Trust nothing -- verify everything.**

## Review Discipline
- Don't assume code is correct because it looks reasonable. Read it.
- Every changed line should trace directly to the stated task. Flag scope creep.
- Check what's NOT there: missing error handling, missing edge cases, missing tests.
- Grade on evidence, not vibes. "Looks good" is not a review.

## Findings Format
- Each finding must include: file path, line number, severity (P0-P3), what's wrong, how to fix it.
- P0: security vulnerability, data loss, crash. P1: incorrect behavior. P2: code quality. P3: style/nit.
- If you find zero issues, say so explicitly with what you checked. Silence is not approval.

## Verification
- For correctness claims, cite the specific code that proves it.
- For "tests pass" claims, check that tests actually test the changed behavior, not just that they exist.
- The orphan rule: flag imports/variables the changes made unused. Don't flag pre-existing dead code.

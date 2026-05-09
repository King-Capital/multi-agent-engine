# Worker Principles

**Smallest change that solves the problem. Verify before reporting done.**

## Code Discipline
- Don't assume. If something is unclear, state your assumption and proceed.
- Minimum code: no speculative features, no premature abstractions, no "while I'm here" cleanup.
- Touch only what the brief asks. Remove imports/variables YOUR changes made unused. Don't touch pre-existing dead code.
- Reframe vague tasks into verifiable goals: "Add validation" becomes "Write tests for invalid inputs, then make them pass."
- Every changed line must trace directly to the assignment.

## Verification
- Define success criteria before coding. What does "done" look like?
- Run tests, typecheck, build after every change. Don't report done without verification.
- If verification fails, fix it. Don't report the failure and wait -- fix what you find.

## Output
- Report WHAT you changed, WHY, and HOW you verified it.
- Include file paths, line numbers, and test results.
- If you hit a blocker after 2 attempts, escalate with: tried X, failed because Y.

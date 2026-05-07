# Debugger

Systematic root-cause debugging. Never fix symptoms.

## Process

1. **Observe** -- Reproduce the bug. Get the exact error, stack trace, and inputs.
2. **Hypothesize** -- List 2-3 possible root causes ranked by likelihood.
3. **Test** -- Add diagnostic output (console.log, print, etc.) to narrow down the cause. Verify or eliminate each hypothesis.
4. **Fix** -- Apply the smallest change that addresses the root cause.
5. **Verify** -- Confirm the original bug is gone AND no new bugs introduced.

## Rules

- Read error messages and stack traces carefully. They usually point to the answer.
- Never fix symptoms. If a null check "fixes" a crash, find out why the value is null.
- Check recent changes first -- most bugs live in new code.
- After fixing, clean up diagnostic output.
- If the fix touches logic, add a test that would have caught the bug.
- If you can't reproduce the bug, say so. Don't guess at fixes.

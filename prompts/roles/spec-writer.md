# Spec Writer

Surface decisions BEFORE code exists.

## When to Write a Spec

- Identify decisions that need human review: API shape, migration approach, error behavior, schemas, data models.
- If a task has no decisions worth surfacing, say so and skip the spec.

## Spec Format

Write specs as structured prompts, not documentation. Output markdown with these sections:

- **Requirements** -- what must be true when done
- **Decisions** -- choices that need human input, with recommended option and tradeoffs
- **Constraints** -- non-negotiable technical/business limits
- **Test Criteria** -- how to verify the implementation is correct

## Rules

- Keep specs under 200 lines.
- Be specific. "Handle errors" is not a decision. "Return 422 vs 400 for validation failures" is.
- Prefer tables for comparing options.
- No implementation details -- that's the builder's job.

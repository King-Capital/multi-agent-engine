---
name: "mae-prompt-engineering"
description: "Write prompts for other agents as the product"
---
# Prompt Engineering

You write prompts for other agents. Your prompts ARE the product.

## Rules

1. Never send a one-liner to a lead or worker. Write a FULL prompt.
2. Every prompt you write must include:
   - **Context**: what has happened so far, what files are relevant
   - **Task**: exactly what to do, in concrete terms
   - **Constraints**: what NOT to do, domain boundaries, model to use
   - **Expected output**: what the response should look like
   - **Success criteria**: how to know the task is done
3. Use variables from the workflow: $INPUT (previous step output), $ORIGINAL (user's initial request).
4. Reference specific file paths, function names, line numbers when possible.
5. Think about what the receiving agent needs to know to succeed WITHOUT asking questions.

## Prompt Template

```
@[Agent Name]:

Context: [what's happened, relevant files]

Task: [specific work to do]
- [step 1]
- [step 2]

Constraints:
- [boundary 1]
- [boundary 2]

Expected output: [format]
Success criteria: [how to verify]
```

## Anti-patterns

- "Do X" with no context → agent wastes tokens exploring
- Vague success criteria → agent doesn't know when to stop
- No domain constraints → agent writes to wrong files
- No model guidance → wrong intelligence level for the task

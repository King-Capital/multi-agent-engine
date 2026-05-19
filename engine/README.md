# engine

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run 
```

This project was created using `bun init` in bun v1.3.11. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Certification Validator

`certification-validator.ts` validates certification traces and artifacts without LLM calls. The CLI entrypoint is:

```bash
bun cli.ts validate-cert <trace-file> [--live-pi] [--strict-spawn] [--json]
```

`--strict-spawn` enforces the Phase 4 worker-spawn policy: every worker spawn must have a valid traced `SPAWN_DECISION` with scoped paths, allowed tools, forbidden paths, isolated bus policy, output schema, and timeout.

## Structured Spawn Decisions

`spawn-decision.ts` owns parsing, validation, and deterministic worker-prompt generation for `SPAWN_DECISION` blocks. `team-execution.ts` uses it to:

- instruct leads to emit worker decisions
- reject missing or invalid decisions in strict mode
- emit `spawn_decision` dashboard events and `spawn.decision` JSONL trace events before `agent_spawn`
- derive worker prompts from the decision contract
- use valid decisions as the strict-mode worker roster
- apply decision tool/path constraints to worker delegate options
- emit derived decisions for strict retry and Sr. recovery spawns

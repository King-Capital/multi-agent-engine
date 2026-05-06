# The Library Meta-Skill: How I Distribute PRIVATE Skills, Agents and Prompts

**Source:** https://www.youtube.com/watch?v=_vpNQ6IwP9w
**Extracted:** 2026-05-05 | 159 frames analyzed

## Key Patterns

- **Three-primitive taxonomy**: Skills (raw capabilities), Agents (scale + parallelism), Prompts (orchestration instructions). Each is a `.md` file.
- **library.yaml as registry**: Single YAML file stores references (not copies) to all skills, agents, and prompts. Each entry has `name`, `description`, `source` (GitHub URL or local path). Agents can declare `requires: [skill:bowser]` for dependency tracking.
- **Dual-scope default_dirs**: `default: .claude/skills/` (project-local) vs `global: ~/.claude/skills/` (machine-global). Same pattern for agents/ and prompts/.
- **Three source types**: Private GitHub, Public GitHub, Local Path. Entries tagged `github` or `local`.
- **Cookbook command pattern**: Operations as separate `.md` files in `cookbook/`: add, install, list, push, remove, search, sync, use.
- **Push workflow**: Bidirectional sync -- clones source repo to temp dir, diffs local vs remote, pushes changes back.
- **Meta-skills that build skills**: `meta-agent`, `meta-prime`, `meta-prompt`, `meta-skill` -- each generates new assets following best practices.

## Config Format (library.yaml)

```yaml
default_dirs:
  skills:
    default: .claude/skills/
    global: ~/.claude/skills/
  agents:
    default: .claude/agents/
    global: ~/.claude/agents/
  prompts:
    default: .claude/commands/
    global: ~/.claude/commands/

library:
  skills:
    - name: bowser
      description: Headless browser automation...
      source: https://github.com/disler/pi-vs-claude-code/blob/main/.pi/skills/bowser.md
  agents:
    - name: code-review
      description: ...
      source: https://github.com/org/agents/code-review.md
      requires: [skill:bowser]
```

## Architecture

- **Single Source of Truth**: Multiple projects reference same library.yaml pointing to one Source Repo.
- **Cross-device sync**: One config keeps Dev Laptop, Mac Mini Agent, and Cloud Sandbox in sync.
- **Role-scoped libraries**: `idd-library-engineer`, `idd-library-support`, `idd-library-sales` -- persona-specific skill sets.

## Applicable to MAE

1. Adopt library.yaml registry pattern for cataloging skills/agents/prompts
2. Cookbook directory for composable operations
3. Default/global dir split for project-local vs machine-global scope
4. `/library use <name>` CLI invocation pattern
5. Push-back workflow for self-improving skills
6. Role-scoped libraries mapping to MAE personas

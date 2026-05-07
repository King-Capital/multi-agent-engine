# Git Agent

Git operations and commit management.

## Commit Messages

Use conventional commits: `type(scope): description`

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `ci`

Examples:
- `feat(auth): add JWT refresh token rotation`
- `fix(api): handle null response from payment provider`
- `test(accounts): add edge case coverage for balance calc`

## Branching

- Branch prefixes: `feat/`, `fix/`, `refactor/`, `docs/`
- Use descriptive branch names: `feat/jwt-refresh`, not `feat/update`

## Staging

- Stage only related changes per commit. No kitchen-sink commits.
- Review `git diff --staged` before committing.
- Separate functional changes from formatting/style changes.

## Forbidden Commands

NEVER use: `push --force`, `reset`, `clean -f`, `checkout .`, `restore .`, `branch -D`, `stash drop`, `stash clear`.

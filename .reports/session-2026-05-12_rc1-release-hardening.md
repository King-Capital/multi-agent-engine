# 2026-05-12 -- RC1 Release Hardening

**Session ID:** AEDFB6E9-D063-4E93-964F-4A98AFB8125D
**Branch:** main

## Done

- PR #241 merged and deployed: optional/config-aware A2A health, MAE config export propagation, LiteLLM/Pi env mapping, Pi timeout/stop behavior, nudge helpers disabled by default.
- A2A configured and verified on remote hosts using MonkeyProof A2A endpoint.
- PR #242 merged and deployed as `v1.0.3`: `mae update` wrapper now updates atomically and preserves symlink installs.
- Five-perspective review swarm ran on the wrapper update; chained symlink regression was found, fixed, and re-reviewed clean for high/medium issues.
- PR #243 merged and deployed as `v1.0.4`: stale open sessions now auto-close as done/completed, with running/idle agents marked done/completed in memory and PG.
- Live dashboard reports `version: 1.0.4`, DB connected. Local, Skippy, and King installs are all `v1.0.4`; Skippy and King health are `HEALTHY`.

## Decisions

- A2A is optional unless configured; MonkeyProof A2A is the coding target for MAE.
- Stale lifecycle cleanup means done/completed, not error, unless a real failure event exists.
- Self-updating wrappers must use temp install plus atomic rename.
- Remote installs should source `~/.mae/config` and `~/.cc-env` for real health checks.

## Files Changed

- `scripts/mae`
- `dashboard/database.go`
- `dashboard/internal/events/store.go`
- `dashboard/internal/events/store_test.go`
- `dashboard/main.go`
- `dashboard/templates/dashboard.templ`
- `README.md`
- `VERSION`

## Known Issues

- Local Codex sandbox health can be false-negative for traces/dashboard/Langfuse.
- Need one controlled large-repo Pi/swarm run after `v1.0.4` to verify nudge/timeout/stale-close behavior under real load.
- GitHub issue cleanup may still be needed for stale-session issue metadata.

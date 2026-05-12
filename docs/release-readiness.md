# Release Readiness

This project is on the `1.0.0_RC1` line. Use this gate before publishing a public RC tag or promoting to `v1.0.0`.

## RC Scope

Shipped adapters:

- `pi`
- `a2a`
- `echo`

Not shipped in this RC:

- `claude-code`
- `codex`

Do not advertise unshipped adapters in the README, deployment guide, release notes, or examples until they have an adapter implementation and an end-to-end smoke test.

## Public RC Gate

Run these checks before tagging a new RC:

```bash
bun test
bunx tsc --noEmit
cd dashboard-next && bun run build
cd ../dashboard && go build -o mae-dashboard .
cd ..
just build
mae version
mae chain review-only "release smoke" --dry-run
```

The release smoke must create a trace with `chain.step.start` and `chain.step.end` events, and `mae score <session-id>` must pass `all_steps_executed`.

## Documentation Gate

Before a public tag:

- README release status matches `VERSION`.
- Adapter tables match the adapters registered by `engine/cli.ts`.
- Dashboard docs describe the Go API plus React SPA, not the legacy templ UI.
- Deployment examples avoid local-only hostnames and unshipped adapters.
- Build artifacts are not tracked in git.

## Tagging

The `VERSION` file stays at `1.0.0_RC1` while this RC line is active. Tag public RC builds manually after the release gate passes:

```bash
git tag -a v1.0.0_RC1.1 -m "v1.0.0_RC1.1"
git push origin v1.0.0_RC1.1
```

Use the next patch-style RC tag for later release-candidate builds, for example `v1.0.0_RC1.2`.

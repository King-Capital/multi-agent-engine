# Release Readiness

This project is on the stable `1.0.x` line. Use this gate before publishing a public tag.

## Release Scope

Shipped adapters:

- `pi`
- `a2a`
- `echo`

Not shipped in this release:

- `claude-code`
- `codex`

Do not advertise unshipped adapters in the README, deployment guide, release notes, or examples until they have an adapter implementation and an end-to-end smoke test.

## Public Release Gate

Run these checks before tagging a release:

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

`VERSION` is the source of truth for stable releases. The auto-version workflow bumps normal SemVer values after merged PRs. When cutting a manual public release, tag the exact `VERSION` value:

```bash
VERSION=$(cat VERSION)
git tag -a "v${VERSION}" -m "v${VERSION}"
git push origin "v${VERSION}"
```

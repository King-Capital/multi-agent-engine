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

Run these checks before tagging a release from the repository root unless a command explicitly changes directories:

```bash
cd engine
bun install --frozen-lockfile
bun test
bun x tsc --noEmit
cd ../dashboard-next && bun run build
cd ../dashboard && go build -o mae-dashboard .
cd ..
just build
mae version
mae chain review-only "release smoke" --dry-run
```

The release smoke must create a trace with `chain.step.start` and `chain.step.end` events, and `mae score <session-id>` must pass `all_steps_executed`.

### Wave 1 Baseline Gates

Wave 1 production-readiness triage established the current baseline at **24/65**. Treat the following as required gates for PRs that claim to improve release readiness:

- Engine local/CI baseline is green: `cd engine && bun test` and `cd engine && bun x tsc --noEmit` both pass.
- TypeScript dependencies used by CLI/TUI entrypoints are present in `engine/package.json`/lockfile and resolvable from a frozen Bun install; do not rely on globally installed modules.
- Strict TypeScript remains enabled; callback parameters in touched engine code must be explicitly typed or contextually typed with no `noImplicitAny` regressions.
- Evidence is recorded in the PR summary, including exact test/typecheck commands and pass/fail counts.
- Any unresolved production-readiness blocker is called out with an owner or follow-up card before merge.

Wave 1 audit artifacts live in `reviews/10000-foot.md`, `reviews/1000-foot.md`, `reviews/100-foot.md`, and `reviews/up-close.md`; use those reports to prioritize follow-up gates such as live Pi certification, dashboard smoke, and security/dependency scans.

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

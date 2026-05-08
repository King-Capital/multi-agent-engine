# Changelog

All notable changes to the Multi-Agent Engine (MAE) will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.32] - 2026-05-07

### Added
- Chain replay player + CLI version/info command (#128)

## [0.2.31] - 2026-05-06

### Added
- Dashboard cost statistics, agent graph visualization, diff viewer, model comparison (#127)

## [0.2.30] - 2026-05-05

### Added
- Reliable chains with pipeline state management (#126)
- Steering architecture for chain execution (#126)
- Sandbox integration for chain steps (#126)
- Chain history and replay support (#126)
- Pi embedded agent support (#126)

## [0.2.29] - 2026-05-04

### Fixed
- Sandbox pool v6 -- restore from backup + GitHub Actions CI (#117)

## [0.2.28] - 2026-05-03

### Changed
- Sandbox pool v5 refactor (#116)

## [0.2.27] - 2026-05-02

### Added
- MAE sandbox pool -- pre-warmed dev LXC containers (#114)

## [0.2.26] - 2026-05-01

### Added
- Sub-agent bridge for cross-agent communication (#111)
- Deterministic lint-first feedback loop (#113)
- Pi as OpenClaw backend feasibility study + Bilby config (#112)

### Fixed
- Clean stream output and SSE connection fixes (#111)
- Steering improvements (#111)

## [0.2.25] - 2026-04-30

### Added
- agentDone event + Grade field for agent evaluation (#110)

## [0.2.24] - 2026-04-29

### Fixed
- Restored openai/gpt-5.5 in model config (#109)
- Updated cross-model test suite (#109)

## [0.2.23] - 2026-04-28

### Added
- Pi harness foundation -- system prompts, safety gate, SDLC skills (#108)
- Dashboard improvements for Pi integration (#108)

## [0.2.22] - 2026-04-27

### Added
- System prompts for Pi harness -- base + 11 role-specific prompts (#106)

## [0.2.21] - 2026-04-26

### Fixed
- Use `/api/health` for deploy health checks (auth-free endpoint) (#93)
- Hydrate session costs, names, and elapsed time from PG on startup (#92)

## [0.2.20] - 2026-04-25

### Added
- Test swarm Phase 4+5 -- security hardening + adapter reliability (#90)

## [0.2.19] - 2026-04-24

### Added
- Test swarm Phase 1+2 + Pi RPC rewrite (#84)

### Fixed
- Phase 3 dead code cleanup -- security, on_feedback, till_done (#83)
- Agent visibility in dashboard + stream text output (#42, #87)

## [0.2.18] - 2026-04-23

### Added
- PG hydration on startup + session lifecycle fixes (#40)

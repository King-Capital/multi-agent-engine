# Complexity Classifier

Classify task complexity to select the right model + thinking level.

## The Matrix

| Tier | Model + Thinking | Effective Speed | When to use |
|------|-----------------|-----------------|-------------|
| **HIGH** | opus high, gpt-5.5, gemini-3.1-pro high | Slow, max quality | Orchestrator decisions, lead coordination, security review, architecture |
| **MEDIUM** | opus low, sonnet medium, gemini-3.1-pro medium | Balanced | Building code, standard implementation, test writing, known patterns |
| **FAST** | sonnet low, sonnet minimal, gemini-3.1-pro low | Fast, cheap | Scouts, file reading, grep/find, triage, format checks |

## Key Insight

Same model, different thinking = different tier:
- **opus high** = HIGH tier (full reasoning, max intelligence)
- **opus low** = MEDIUM tier (still smart, but fast)
- **sonnet medium** = MEDIUM tier (balanced worker)
- **sonnet low** = FAST tier (scout-speed with sonnet quality)
- **sonnet minimal** = FAST tier (near-zero overhead)

## Classification Rules

**HIGH** (thinking: high):
- Orchestrator and lead decisions — always
- Task spans 3+ files or systems
- Security, auth, or credential handling
- Architectural reasoning or trade-off analysis
- Novel problem solving (no existing pattern)
- Cross-model verification (verifier tier)

**MEDIUM** (thinking: medium, or opus with thinking: low):
- Implementing a written plan
- Following existing codebase patterns
- Standard CRUD, API endpoints, UI components
- Writing tests for existing code
- Bug fixes with clear reproduction

**FAST** (thinking: low or minimal):
- Codebase exploration and mapping
- File reading for context
- Running grep/find for discovery
- Quick formatting or lint checks
- Triage pass before deep review
- Mental model updates

## Bias

When uncertain, bias HIGH. Rework from a dumb answer costs more than extra tokens from a smart one. Only exception: scouts should always be FAST — breadth over depth.

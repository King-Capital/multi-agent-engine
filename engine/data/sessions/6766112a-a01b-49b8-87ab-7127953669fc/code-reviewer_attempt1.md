# Code Reviewer - Attempt 1
Grade: unknown
Cost: $0.0000
Tokens: 30115

## Output

Now I have everything needed for a comprehensive review. Let me compile the findings:

---

# Code Review: `engine/config.ts`

## Bug Report — P0–P3 Graded Findings

---

### 1. **P1 — `cachedRead()` crashes on deleted files (no try/catch on `statSync`)**

**File:** `engine/config.ts`, **line 18**

```ts
const stat = statSync(fullPath);   // line 18 — throws ENOENT if file deleted
```

**Issue:** `statSync` will throw an uncaught `ENOENT` error if the file is deleted while the engine is running. Compare with `loadExpertise()` (line 61) which defensively checks `existsSync()` first. Since `cachedRead` is the backbone for `loadTeams()`, `loadChains()`, `loadModelRouting()`, `resolveModel()`, and `getCrossModelVerifier()` — all called repeatedly during a session — a deleted YAML config file will crash the entire orchestrator mid-session with an unhelpful `ENOENT: no such file or directory` stack trace.

**Impact:** Any deletion or rename of `teams.yaml`, `chains.yaml`, or `model-routing.yaml` while a session is running produces an unrecoverable crash. This is plausible during development (editing configs while engine runs) and in CI (concurrent processes).

**Suggested fix:**
```ts
function cachedRead<T>(path: string): T {
  const fullPath = join(BASE_DIR, path);
  let stat;
  try {
    stat = statSync(fullPath);
  } catch (err: any) {
    const cached = cache.get(fullPath);
    if (cached) return cached.data as T;  // Serve stale if available
    throw new Error(`Config file not found: ${path} (${err.code ?? err.message})`);
  }
  const cached = cache.get(fullPath);
  if (cached && cached.mtime === stat.mtimeMs) return cached.data as T;
  const raw = readFileSync(fullPath, "utf-8");
  const data = parseYaml(raw);
  cache.set(fullPath, { data, mtime: stat.mtimeMs });
  return data as T;
}
```

---

### 2. **P1 — `buildSystemPrompt()` null safety — runtime crash on sparse persona YAML**

**File:** `engine/config.ts`, **lines 85–95**

```ts
const skills = persona.skills.map(...)   // line 85 — crashes if skills is undefined
// ...
`Tools: ${persona.tools.join(", ")}`,    // line 89 — crashes if tools is undefined
`Read: ${persona.domain.read.join(", ")}`,  // line 92 — crashes if domain/domain.read is undefined
`Write: ${persona.domain.write.join(", ")}`, // line 93 — crashes if domain/domain.write is undefined
```

**Issue:** TypeScript's `PersonaConfig` type (types.ts:11–18) declares `skills`, `tools`, and `domain` as required, but **TypeScript types are not enforced at runtime on YAML-parsed data**. If a persona YAML file is missing any of these keys (e.g., a newly scaffolded persona with only `name` and `model`), the function throws `.map is not a function` or `Cannot read properties of undefined (reading 'read')` — non-descriptive errors with no indication of which persona file is malformed.

**Evidence of real risk:** The `just new-agent` scaffolder could produce a persona with empty/missing fields. Also, `DomainConfig` has `delete?: string[]` as optional — showing the types already allow partial domain configs — but code assumes `read` and `write` always exist.

**Suggested fix:**
```ts
export function buildSystemPrompt(persona: PersonaConfig): string {
  const skills = (persona.skills ?? []).map((s) => loadSkill(resolveSkillPath(s))).join("\n\n---\n\n");
  const expertise = persona.expertise ? loadExpertise(persona.expertise) : "";
  const tools = (persona.tools ?? []).join(", ") || "none";
  const readPaths = (persona.domain?.read ?? []).join(", ") || "none";
  const writePaths = (persona.domain?.write ?? []).join(", ") || "none";

  return [
    `# ${persona.name}`,
    "",
    `Model: ${persona.model}`,
    `Tools: ${tools}`,
    "",
    "## Domain",
    `Read: ${readPaths}`,
    `Write: ${writePaths}`,
    "",
    "## Skills",
    "",
    skills,
    "",
    expertise ? `## Expertise\n\n${expertise}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
```

---

### 3. **P2 — `loadPersona()` uncached: 6+ synchronous file reads per chain step**

**File:** `engine/config.ts`, **lines 36–42**

```ts
export function loadPersona(path: string): PersonaConfig {
  const fullPath = join(BASE_DIR, path);
  const raw = readFileSync(fullPath, "utf-8");   // No cache, every call hits disk
  // ...
}
```

**Issue:** `loadTeams()`, `loadChains()`, and `loadModelRouting()` all go through `cachedRead` (mtime-checked cache). But `loadPersona()` does a raw `readFileSync` every time. In `orchestrator.ts`, `loadPersona` is called:
- Line 239: orchestrator persona (1×)
- Line 344: team lead persona (1× per team step)
- Line 414: worker persona (1× per worker)
- Line 596: solo agent persona (1× per agent step)

For a team of 5 workers, that's 6 synchronous file reads (lead + 5 workers) per step. Over a 3-step chain with 3 teams, that's ~18 blocking disk reads for files that never change during a session.

**Impact:** Not a correctness bug — purely performance. The personas are small markdown files (~1-2KB), so each read is fast. But it's inconsistent with the caching pattern used everywhere else, and synchronous I/O blocks the event loop.

**Verdict:** Likely unintentional. The persona files aren't mutated during a session (only expertise files are). This should use `cachedRead` or a dedicated persona cache. However, since `loadPersona` does frontmatter parsing (not full-file YAML like `cachedRead`), it would need its own cache variant:

```ts
const personaCache = new Map<string, { data: PersonaConfig; mtime: number }>();

export function loadPersona(path: string): PersonaConfig {
  const fullPath = join(BASE_DIR, path);
  const stat = statSync(fullPath);           // should also have try/catch per Finding #1
  const cached = personaCache.get(fullPath);
  if (cached && cached.mtime === stat.mtimeMs) return cached.data;
  const raw = readFileSync(fullPath, "utf-8");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) throw new Error(`No frontmatter in ${path}`);
  const data = parseYaml(fmMatch[1]!) as PersonaConfig;
  personaCache.set(fullPath, { data, mtime: stat.mtimeMs });
  return data;
}
```

---

### 4. **P2 — Frontmatter regex fails on Windows line endings (`\r\n`)**

**File:** `engine/config.ts`, **line 39** and **line 47**

```ts
// loadPersona - line 39
const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);

// loadPrompt - line 47
const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
```

**Issue:** Both regexes use literal `\n` for line endings. If any persona or prompt file has Windows-style `\r\n` line endings, the match fails entirely, throwing `No frontmatter in ${path}` — a misleading error suggesting the file is malformed when it's just a line ending issue.

**Current risk assessment:** I checked the existing persona files and they all use `\n` (no matches for `\r\n`). However:
- Contributors on Windows may introduce `\r\n` files
- Git's `core.autocrlf` setting could convert on checkout
- No `.gitattributes` file was found enforcing line endings

**Additional `loadPrompt` issue (line 47):** The `$` anchor with `([\s\S]*)$` — the `$` in a regex without the `m` flag matches end-of-string. Since `[\s\S]*` is greedy and matches everything including newlines, the `$` is effectively a no-op here. This is technically correct but misleading. The bigger risk is if a file ends with `\r\n` — then `\n([\s\S]*)$` would leave a stray `\r` at the start of the body.

**Suggested fix:**
```ts
// Use \r?\n to handle both line ending styles
const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);           // loadPersona
const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/); // loadPrompt
```

Or normalize upfront:
```ts
const raw = readFileSync(fullPath, "utf-8").replace(/\r\n/g, "\n");
```

---

### 5. **P2 — `loadModelRouting()` return type is incomplete**

**File:** `engine/config.ts`, **lines 101–105**

```ts
export function loadModelRouting(): {
  budgets?: { max_per_session_usd: number; warn_at_usd: number; max_per_agent_usd: number; max_total_tokens: number };
  aliases?: Record<string, string>;
  models?: Record<string, { primary: string }>;
} {
```

**Issue:** The actual `model-routing.yaml` contains `tiers`, `roleDefaults`, and `crossModelPairs` — none of which appear in the return type. The return type declares a `models` field that **doesn't exist in the YAML at all**.

The only consumer of `loadModelRouting()` is `orchestrator.ts` line 330 (via `loadBudgets()`), which only accesses `.budgets`, so this doesn't cause a runtime bug today. But the type is actively misleading:
- `models` is declared but doesn't exist in the config → always `undefined`
- `tiers`, `roleDefaults`, `crossModelPairs` exist in the config but are invisible to TypeScript

Any future caller trying to use `loadModelRouting().tiers` would get a type error even though the data is there at runtime.

**Suggested fix:** Create a proper interface in `types.ts`:
```ts
export interface ModelRoutingConfig {
  tiers: Record<string, {
    description: string;
    options: { model: string; thinking: string; note: string }[];
    default: string;
    default_thinking: string;
    context: number;
  }>;
  aliases: Record<string, string>;
  roleDefaults: Record<string, { tier: string; thinking: string }>;
  crossModelPairs: { builder: string; verifier: string }[];
  budgets: {
    max_per_session_usd: number;
    warn_at_usd: number;
    max_per_agent_usd: number;
    max_total_tokens: number;
  };
}
```

---

### 6. **P3 — `resolveModel()` / `getCrossModelVerifier()` double cache lookup**

**File:** `engine/config.ts`, **lines 108–116** and **lines 127–141**

```ts
// resolveModel (line 108) reads model-routing.yaml via cachedRead
export function resolveModel(alias: string): string {
  const config = cachedRead<...>("configs/model-routing.yaml");
  // ...
}

// getCrossModelVerifier (line 127) reads model-routing.yaml via cachedRead
// AND calls resolveModel() which reads it AGAIN
export function getCrossModelVerifier(builderModel: string): string | null {
  const config = cachedRead<...>("configs/model-routing.yaml");   // read #1
  // ...
  const resolvedBuilder = resolveModel(builderModel);              // read #2 (inside resolveModel)
  // ...
}
```

**Issue:** `getCrossModelVerifier` triggers 2 cache lookups for the same file. Each `cachedRead` call does a `statSync` + `Map.get` + mtime comparison, so it's ~2 syscalls per redundant call.

**Impact:** Negligible. The cache hit path is a `statSync` + Map lookup — microseconds. `getCrossModelVerifier` is called at most once per team step (if at all — I didn't find any calls in `orchestrator.ts`). This is a code cleanliness issue, not a performance issue.

**Suggested fix (optional):**
```ts
export function getCrossModelVerifier(builderModel: string): string | null {
  const config = cachedRead<{
    crossModelPairs?: CrossModelPair[];
    aliases?: Record<string, string>;
    models?: Record<string, { primary: string }>;
  }>("configs/model-routing.yaml");

  if (!config.crossModelPairs?.length) return null;

  // Inline resolve instead of calling resolveModel()
  const resolvedBuilder = config.aliases?.[builderModel]
    ?? config.models?.[builderModel]?.primary
    ?? builderModel;

  const pair = config.crossModelPairs.find(
    (p) => p.builder === resolvedBuilder || p.builder === builderModel
  );
  return pair?.verifier ?? null;
}
```

---

### 7. **P3 — `loadSkill()` and `loadExpertise()` return raw strings (verify intentional)**

**File:** `engine/config.ts`, **lines 55–64**

```ts
export function loadSkill(path: string): string {
  const fullPath = join(BASE_DIR, path);
  return readFileSync(fullPath, "utf-8");
}

export function loadExpertise(path: string): string {
  const fullPath = join(BASE_DIR, path);
  if (!existsSync(fullPath)) return "";
  return readFileSync(fullPath, "utf-8");
}
```

**Verdict: Intentional.** These load markdown files (skill definitions, expertise docs), not YAML configs. The only consumer is `buildSystemPrompt()` (lines 85–86), which concatenates them as raw text into the system prompt string. No caller ever expects parsed output.

**Minor note:** `loadSkill` does not have the `existsSync` guard that `loadExpertise` has. If a persona references a skill path that doesn't exist, `loadSkill` will throw a raw `ENOENT`. This is arguably correct (missing skills are a hard error, missing expertise is soft/optional), but worth noting for consistency.

---

### 8. **P2 — Frontmatter regex edge case: YAML `---` document separator inside frontmatter**

**File:** `engine/config.ts`, **line 39**

```ts
const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
```

**Issue:** The non-greedy `*?` correctly matches the *first* `\n---` after the opening delimiter. However, if a persona's YAML frontmatter contains a line that is exactly `---` (a valid YAML document separator), the regex will terminate early, capturing only a partial frontmatter block.

**Example that would break:**
```yaml
---
name: Test Agent
model: quality
notes: |
  ---
  some separator
skills: []
tools: [read]
domain:
  read: ["**/*"]
  write: []
  update: []
---
```

The regex would match only up to the `---` inside the `notes:` block, producing invalid YAML for `parseYaml()`.

**Current risk:** Low. Examining all 10 existing personas, none use `---` as a value in their frontmatter. This is a standard limitation of frontmatter parsing shared by Hugo, Jekyll, and most static site generators. But it's worth documenting as a constraint.

**Mitigation:** Document in the persona authoring guide that `---` on its own line inside frontmatter is not supported, or switch to a proper frontmatter parser like `gray-matter`.

---

## Summary

| # | Severity | Area | Issue |
|---|----------|------|-------|
| 1 | **P1** | `cachedRead` L18 | `statSync` crashes on deleted file — no try/catch, no fallback to stale cache |
| 2 | **P1** | `buildSystemPrompt` L85–95 | No null checks on `persona.skills`, `.tools`, `.domain.read`, `.domain.write` — runtime crash on sparse YAML |
| 3 | **P2** | `loadPersona` L36–42 | Uncached `readFileSync` every call — 6+ blocking reads per team step; inconsistent with `cachedRead` pattern |
| 4 | **P2** | `loadPersona` L39, `loadPrompt` L47 | Frontmatter regex uses `\n` only — fails silently on `\r\n` (Windows) |
| 5 | **P2** | `loadModelRouting` L101–105 | Return type declares nonexistent `models` field, omits `tiers`/`roleDefaults`/`crossModelPairs` |
| 6 | **P3** | `resolveModel`/`getCrossModelVerifier` | Double cache lookup for same YAML file — negligible perf impact, code cleanliness |
| 7 | **P3** | `loadSkill`/`loadExpertise` | Raw string return is intentional (markdown, not YAML). `loadSkill` lacks `existsSync` guard unlike `loadExpertise` |
| 8 | **P2** | Frontmatter regex L39 | Non-greedy match terminates early if YAML contains literal `---` line — standard frontmatter limitation |

**Recommended fix priority:** #1 and #2 should be fixed before any production use — both are crash-on-plausible-input bugs. #3–5 are quality/correctness improvements worth addressing in the next PR. #6–8 are informational.


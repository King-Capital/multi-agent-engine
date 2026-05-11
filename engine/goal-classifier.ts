import { loadChains } from "./config";
import { callLLM } from "./llm-gateway";

export interface ClassificationResult {
  chain: string;
  confidence: number;
  reasoning: string;
}

const DEFAULT_CHAIN = "plan-build-review";

export async function classifyGoal(goal: string): Promise<ClassificationResult> {
  const chainsFile = loadChains();
  const chainEntries = Object.entries(chainsFile.chains);

  const chainList = chainEntries
    .map(([name, chain]) => `- ${name}: ${chain.description}`)
    .join("\n");

  const system = `You are classifying a software engineering task into the best execution chain.

Available chains:
${chainList}

Respond with ONLY valid JSON (no markdown, no code fences):
{"chain": "chain-name", "confidence": 0.0-1.0, "reasoning": "brief reason"}`;

  const user = `Task: "${goal}"`;

  try {
    const raw = await callLLM({
      system,
      user,
      model: "fast",
      maxTokens: 256,
      temperature: 0,
    });

    return parseClassification(raw, chainEntries.map(([name]) => name));
  } catch {
    return { chain: DEFAULT_CHAIN, confidence: 0, reasoning: "Classification failed, using default" };
  }
}

function parseClassification(raw: string, validChains: string[]): ClassificationResult {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/```(?:json)?\n?/g, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
    const chain = typeof parsed.chain === "string" ? parsed.chain : DEFAULT_CHAIN;
    const confidence = typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0;
    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";

    if (!validChains.includes(chain)) {
      return { chain: DEFAULT_CHAIN, confidence: 0, reasoning: `Unknown chain "${chain}", using default` };
    }

    return { chain, confidence, reasoning };
  } catch {
    return { chain: DEFAULT_CHAIN, confidence: 0, reasoning: "Failed to parse classification response" };
  }
}

// Exported for testing
export { parseClassification as _parseClassification };

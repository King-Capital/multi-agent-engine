import * as p from "@clack/prompts";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { loadPersona, loadExpertise, buildSystemPrompt, BASE_DIR } from "./config";
import { callLLM } from "./llm-gateway";

// --- Prompts ---

const TEST_PROMPT =
  "Describe your domain expertise and demonstrate how you would approach implementing " +
  "a typical feature in your domain. Be specific about patterns, tools, and conventions " +
  "you'd follow.";

const GRADER_SYSTEM =
  "You are an expert evaluator of AI agent expertise quality. " +
  "Grade responses objectively and provide actionable feedback.";

function buildGraderPrompt(response: string): string {
  return `Grade the following agent response for expertise quality.

Score 1-10 on each dimension:
- **Specificity**: Does it reference actual patterns, files, or conventions (not generic advice)?
- **Depth**: Does it go beyond surface-level understanding?
- **Actionability**: Could another developer follow this to implement a real feature?

Format your response as:

SCORES:
Specificity: X/10
Depth: X/10
Actionability: X/10
Overall: X/10

IMPROVEMENTS:
1. [First specific improvement to the expertise file]
2. [Second specific improvement]
3. [Third specific improvement]

ASSESSMENT:
[1-2 sentence summary of the expertise quality]

--- AGENT RESPONSE ---

${response}`;
}

// --- Score parsing ---

interface ValidationResult {
  specificity: number;
  depth: number;
  actionability: number;
  overall: number;
  improvements: string[];
  assessment: string;
  raw: string;
}

function parseGraderResponse(raw: string): ValidationResult {
  const result: ValidationResult = {
    specificity: 0,
    depth: 0,
    actionability: 0,
    overall: 0,
    improvements: [],
    assessment: "",
    raw,
  };

  // Parse scores
  const specificityMatch = raw.match(/Specificity:\s*(\d+)/i);
  const depthMatch = raw.match(/Depth:\s*(\d+)/i);
  const actionabilityMatch = raw.match(/Actionability:\s*(\d+)/i);
  const overallMatch = raw.match(/Overall:\s*(\d+)/i);

  if (specificityMatch) result.specificity = parseInt(specificityMatch[1]!, 10);
  if (depthMatch) result.depth = parseInt(depthMatch[1]!, 10);
  if (actionabilityMatch) result.actionability = parseInt(actionabilityMatch[1]!, 10);
  if (overallMatch) result.overall = parseInt(overallMatch[1]!, 10);

  // Parse improvements
  const improvementSection = raw.match(/IMPROVEMENTS:\s*\n([\s\S]*?)(?:\n(?:ASSESSMENT|---)|$)/i);
  if (improvementSection) {
    const lines = improvementSection[1]!.trim().split("\n");
    for (const line of lines) {
      const cleaned = line.replace(/^\d+\.\s*/, "").trim();
      if (cleaned.length > 0) result.improvements.push(cleaned);
    }
  }

  // Parse assessment
  const assessmentSection = raw.match(/ASSESSMENT:\s*\n([\s\S]*?)$/i);
  if (assessmentSection) {
    result.assessment = assessmentSection[1]!.trim();
  }

  return result;
}

// --- Main entry ---

export async function expertiseValidate(args: string[]): Promise<void> {
  // 1. Resolve agent name
  const agentName = args.find((a) => !a.startsWith("--"));

  if (!agentName) {
    p.log.error("Usage: mae validate-agent <name>");
    p.log.info("  <name>  Agent name (must have persona + expertise files)");
    return;
  }

  // 2. Load persona
  const personaPath = `agents/personas/${agentName}.md`;
  const personaFullPath = join(BASE_DIR, personaPath);

  if (!existsSync(personaFullPath)) {
    p.log.error(`Persona not found: ${personaPath}`);
    p.log.info("Available personas:");
    try {
      const personas = readdirSync(join(BASE_DIR, "agents/personas"))
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(".md", ""));
      for (const name of personas) {
        p.log.info(`  ${name}`);
      }
    } catch { /* ignore */ }
    return;
  }

  let persona;
  try {
    persona = loadPersona(personaPath);
  } catch (err: unknown) {
    p.log.error(`Failed to load persona: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 3. Load expertise
  const expertise = loadExpertise(persona.expertise);

  if (!expertise || expertise.trim().length < 50) {
    p.log.error(`Expertise for "${agentName}" is empty or just a stub.`);
    p.log.info(`Run: mae learn --from <path> --agent ${agentName}`);
    return;
  }

  p.intro(`Validate Agent: ${agentName}`);
  p.log.info(`Persona: ${personaPath}`);
  p.log.info(`Expertise: ${persona.expertise} (${expertise.split("\n").length} lines)`);

  // Validation loop
  const MAX_ITERATIONS = 10;
  let iteration = 1;
  while (iteration <= MAX_ITERATIONS) {
    if (iteration > 1) {
      p.log.step(`Re-validation (iteration ${iteration})`);
      // Reload expertise in case it was edited
      const freshExpertise = loadExpertise(persona.expertise);
      if (!freshExpertise || freshExpertise.trim().length < 50) {
        p.log.error("Expertise file is now empty. Stopping.");
        break;
      }
    }

    // 5. Build system prompt and run test
    let systemPrompt: string;
    try {
      systemPrompt = buildSystemPrompt(persona, "worker");
    } catch (err: unknown) {
      p.log.error(`Failed to build system prompt: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const spin = p.spinner();
    spin.start("Running agent on test prompt...");

    let agentResponse: string;
    try {
      agentResponse = await callLLM({ system: systemPrompt, user: TEST_PROMPT, temperature: 0.3 });
    } catch (err: unknown) {
      spin.stop("Agent test failed");
      p.log.error(err instanceof Error ? err.message : String(err));
      return;
    }
    spin.stop("Agent responded");

    // Show agent response
    const responsePreview = agentResponse.split("\n").slice(0, 20).join("\n");
    p.note(
      responsePreview + (agentResponse.split("\n").length > 20 ? "\n... (truncated)" : ""),
      "Agent Response",
    );

    // 7. Grade the response
    spin.start("Grading expertise quality...");

    let graderRaw: string;
    try {
      graderRaw = await callLLM({ system: GRADER_SYSTEM, user: buildGraderPrompt(agentResponse), temperature: 0.3 });
    } catch (err: unknown) {
      spin.stop("Grading failed");
      p.log.error(err instanceof Error ? err.message : String(err));
      return;
    }
    spin.stop("Grading complete");

    const result = parseGraderResponse(graderRaw);

    // Display scores
    const scoreBlock = [
      `Specificity:    ${result.specificity}/10`,
      `Depth:          ${result.depth}/10`,
      `Actionability:  ${result.actionability}/10`,
      `Overall:        ${result.overall}/10`,
      "",
      ...result.improvements.map((imp, i) => `${i + 1}. ${imp}`),
      "",
      result.assessment,
    ].join("\n");

    p.note(scoreBlock, "Validation Results");

    if (result.overall >= 8) {
      p.log.success("Expertise quality is strong.");
    } else if (result.overall >= 5) {
      p.log.warn("Expertise could be improved.");
    } else {
      p.log.error("Expertise needs significant work.");
    }

    // 8. Offer to re-validate
    const editAndRetry = await p.confirm({
      message: "Edit expertise and re-validate?",
    });

    if (p.isCancel(editAndRetry) || !editAndRetry) {
      break;
    }

    const expertiseFullPath = join(BASE_DIR, persona.expertise);
    p.log.info(`Edit the file and come back:`);
    p.log.info(`  ${expertiseFullPath}`);

    const ready = await p.confirm({
      message: "Ready to re-validate?",
    });

    if (p.isCancel(ready) || !ready) {
      break;
    }

    iteration++;
  }

  if (iteration > MAX_ITERATIONS) {
    p.log.warn("Max iterations reached.");
  }

  p.outro("Validation complete.");
}

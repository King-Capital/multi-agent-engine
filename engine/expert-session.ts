import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "fs";
import { join, resolve, basename } from "path";
import { expertiseLearn } from "./expertise-builder";
import { callLLM } from "./llm-gateway";
import type { ChatMessage } from "./llm-gateway";
import { getFlag, stripFlags, slugify } from "./cli-utils";
import { BASE_DIR } from "./config";

/** Try to read a file, returning null if it doesn't exist or can't be read. */
function tryReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

const MAX_HISTORY = 40;

// --- Main entry ---

export async function expertSession(args: string[]): Promise<void> {
  // 1. Resolve target path
  const positional = stripFlags(args);
  const targetPath = positional[0];

  if (!targetPath) {
    p.log.error("Usage: mae expert <path> [--agent <name>]");
    p.log.info("  <path>  Directory to become an expert on");
    p.log.info("  --agent Use a specific agent's expertise");
    return;
  }

  const resolvedPath = resolve(targetPath);
  if (!existsSync(resolvedPath)) {
    p.log.error(`Path not found: ${resolvedPath}`);
    return;
  }

  // 2. Determine agent name and expertise path
  const explicitAgent = getFlag(args, "--agent");
  const dirSlug = slugify(basename(resolvedPath));
  const agentName = explicitAgent ?? `expert-${dirSlug}`;
  const slug = slugify(agentName);
  const expertisePath = join(BASE_DIR, "agents/expertise", `${slug}.md`);

  // 3. Load or generate expertise
  let expertiseContent: string;

  const existingRaw = tryReadFile(expertisePath);
  if (existingRaw !== null) {
    if (existingRaw.trim().length > 50) {
      p.log.success(`Loaded expertise for ${agentName}`);
      expertiseContent = existingRaw;
    } else {
      // Stub file -- needs generation
      p.log.warn(`Expertise file exists but is empty. Generating...`);
      p.log.info("Building expertise from codebase...");
      try {
        await expertiseLearn(["--from", resolvedPath, "--agent", agentName]);
      } catch (err: unknown) {
        p.log.error(err instanceof Error ? err.message : String(err));
        return;
      }

      // Re-read after generation
      const generated = tryReadFile(expertisePath);
      if (generated === null) {
        p.log.error("Expertise generation did not produce a file. Aborted.");
        return;
      }
      expertiseContent = generated;
    }
  } else {
    // No expertise exists -- generate it
    p.log.info(`No expertise found for "${agentName}". Generating from ${resolvedPath}...`);
    try {
      await expertiseLearn(["--from", resolvedPath, "--agent", agentName]);
    } catch (err: unknown) {
      p.log.error(err instanceof Error ? err.message : String(err));
      return;
    }

    const generated = tryReadFile(expertisePath);
    if (generated === null) {
      p.log.error("Expertise generation was cancelled or failed.");
      return;
    }
    expertiseContent = generated;
  }

  if (expertiseContent.trim().length < 50) {
    p.log.error("Expertise content is too short to start a session.");
    return;
  }

  // 4. Enter interactive REPL
  p.intro(`Expert Session: ${agentName}`);

  const previewLines = expertiseContent.split("\n").slice(0, 5).join("\n");
  p.note(previewLines + "\n...", "Expertise Preview");

  const systemPrompt = expertiseContent + "\n\n" +
    "You are an expert on this codebase. Answer questions, suggest implementations, " +
    "explain architecture. Be specific and reference actual files/patterns.";

  const conversationHistory: ChatMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  while (true) {
    const question = await p.text({
      message: "Ask anything (q to quit)",
      validate: (v) => { if (!v?.trim()) return "Type a question or 'q' to quit"; },
    });

    if (p.isCancel(question) || question === "q" || question === "quit") {
      break;
    }

    conversationHistory.push({ role: "user", content: question });

    // Sliding window: keep system message + last MAX_HISTORY-1 messages
    if (conversationHistory.length > MAX_HISTORY) {
      const systemMsg = conversationHistory[0]!;
      const recent = conversationHistory.slice(-(MAX_HISTORY - 1));
      conversationHistory.length = 0;
      conversationHistory.push(systemMsg, ...recent);
    }

    const spin = p.spinner();
    spin.start("Thinking...");

    try {
      const response = await callLLM({ messages: conversationHistory, temperature: 0.3 });
      spin.stop("Done");
      conversationHistory.push({ role: "assistant", content: response });
      console.log(`\n${response}\n`);
    } catch (err: unknown) {
      spin.stop("Error");
      p.log.error(err instanceof Error ? err.message : String(err));
      // Remove the failed user message from history
      conversationHistory.pop();
    }
  }

  p.log.info(`Expertise file: agents/expertise/${slug}.md`);
  p.outro("Session ended.");
}

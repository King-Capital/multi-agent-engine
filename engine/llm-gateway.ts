import { resolveModel } from "./config";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface CallLLMOpts {
  system?: string;
  user?: string;
  messages?: ChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/** Send a chat completion to the LiteLLM gateway. */
export async function callLLM(opts: CallLLMOpts): Promise<string> {
  const gatewayUrl = process.env.MAE_LLM_GATEWAY_URL ?? process.env.LITELLM_URL;
  if (!gatewayUrl) throw new Error("LLM gateway not configured. Set MAE_LLM_GATEWAY_URL or LITELLM_URL.");
  const apiKey = process.env.MAE_LLM_GATEWAY_KEY ?? process.env.LITELLM_API_KEY ?? "";

  const model = resolveModel(opts.model ?? "quality");

  const messages: ChatMessage[] = opts.messages ?? [
    ...(opts.system ? [{ role: "system" as const, content: opts.system }] : []),
    ...(opts.user ? [{ role: "user" as const, content: opts.user }] : []),
  ];

  const resp = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: opts.maxTokens ?? 4096,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`LLM gateway error (${resp.status}): ${body.slice(0, 200)}`);
  }

  const json = await resp.json() as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content ?? "";
}

export type { ChatMessage, CallLLMOpts };

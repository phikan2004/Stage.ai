import Anthropic from "@anthropic-ai/sdk";
import { AnalysisSchema, normalizeRegions, type Region } from "../../shared/schema.ts";
import { RESPONSE_SCHEMA, SYSTEM_PROMPT, userPrompt } from "./prompt.ts";

export const DEFAULT_MODEL = "claude-opus-5-5";
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export class AnalyzeError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic());

const model = () => process.env.VISION_MODEL || DEFAULT_MODEL;
// Opus 5.5 defaults to "medium"; boxes need careful measuring, so ask for more.
const effort = () => (process.env.VISION_EFFORT || "high") as Effort;

function parseDataUrl(url: string) {
  const m = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/.exec(url);
  if (!m) throw new AnalyzeError("Image must be a base64 JPEG, PNG, GIF or WebP data URL.", 400);
  return { media_type: m[1] as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: m[2] };
}

async function callModel(image: string, retryError?: string): Promise<unknown> {
  const res = await getClient().beta.messages.create({
    model: model(),
    max_tokens: 16000,
    // On a safety decline, re-run on Anthropic's recommended fallback model instead of failing.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: effort(), format: { type: "json_schema", schema: RESPONSE_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", ...parseDataUrl(image) } },
          { type: "text", text: userPrompt(retryError) },
        ],
      },
    ],
  });

  if (res.stop_reason === "refusal") {
    throw new AnalyzeError(`Claude declined to analyze this slide${res.stop_details?.explanation ? `: ${res.stop_details.explanation}` : "."}`);
  }
  if (res.stop_reason === "max_tokens") throw new Error("response was cut off (max_tokens)");
  const text = res.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("empty response");
  return JSON.parse(text);
}

function validate(json: unknown): Region[] {
  const parsed = AnalysisSchema.parse(json);
  if (parsed.regions.length < 3) throw new Error(`expected 3 to 8 regions, got ${parsed.regions.length}`);
  return normalizeRegions(parsed.regions.slice(0, 8));
}

/** Ask Claude for regions; validate and retry once with the error fed back. */
export async function analyzeSlide(image: string): Promise<Region[]> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AnalyzeError("ANTHROPIC_API_KEY is not set on the server. Add it to .env, or use the sample deck.", 503);
  }
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return validate(await callModel(image, attempt ? lastError : undefined));
    } catch (e) {
      if (e instanceof AnalyzeError) throw e;
      if (e instanceof Anthropic.AuthenticationError) throw new AnalyzeError("Claude rejected the API key. Check ANTHROPIC_API_KEY in .env.", 401);
      if (e instanceof Anthropic.RateLimitError) throw new AnalyzeError("Claude rate limit hit. Wait a moment and retry the failed slides.", 429);
      if (e instanceof Anthropic.APIError) throw new AnalyzeError(`Claude API error: ${e.message}`, e.status ?? 502);
      lastError = e instanceof Error ? e.message.slice(0, 800) : String(e);
    }
  }
  throw new AnalyzeError(`Claude returned invalid regions twice: ${lastError}`);
}

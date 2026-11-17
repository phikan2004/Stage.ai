import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import { CueSchema, DeckPlanRequestSchema, logRetentionMs, SlideFactsSchema } from "../../shared/schema.ts";
import { AnalyzeError, analyzeSlide, currentPlan, describeRegion, learnFromRun, model, planDeck, type UsageSink } from "./analyze.ts";
import { libraryRouter } from "./library.ts";
import { deckFeedback, deckScript, showFeedback, showScript } from "./rehearse.ts";
import { CueChatRequestSchema, DeckFeedbackRequestSchema, DeckScriptRequestSchema, ShowFeedbackRequestSchema } from "../../shared/rehearse.ts";
import { cueChat } from "./cueChat.ts";
import { FileStore, type Library } from "./store.ts";
import { SupabaseStore } from "./supabaseStore.ts";
import { createSttSession, SttError } from "./stt.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: join(root, ".env"), quiet: true, override: true });

// Supabase when configured, otherwise a local JSON store in data/.
async function openLibrary(): Promise<Library> {
  const env = process.env;
  // PRODUCER_STORE=file keeps a local run away from the configured Supabase project.
  if (env.PRODUCER_STORE !== "file" && (env.DATABASE_URL || env.SUPABASE_URL)) {
    const s = SupabaseStore.fromEnv(env);
    await s.check();
    return s;
  }
  if (env.VERCEL) throw new Error("Vercel has no persistent disk: set DATABASE_URL, SUPABASE_URL and SUPABASE_SECRET_KEY.");
  const s = new FileStore(env.DATA_DIR || join(root, "data"));
  await s.load();
  return s;
}
const store = await openLibrary();

/** Run logs are for learning, not an archive: each is read right after it's saved, then expires. */
const expireRuns = () =>
  store
    .expireRuns(Date.now() - logRetentionMs(process.env))
    .then((n) => n && console.log(`expired ${n} run log${n === 1 ? "" : "s"}`))
    .catch((e) => console.error(`run expiry failed: ${e instanceof Error ? e.message : e}`));
void expireRuns();

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(
  "/api",
  libraryRouter(store, (runId) => {
    learnFromRun(runId, store)
      .catch((e) => console.error(`learn: run ${runId} failed: ${e instanceof Error ? e.message : e}`))
      // Expire after learning, so this run's own transcript is always read first. Runs on every save, so
      // it also works on hosts with no long-lived process.
      .finally(expireRuns);
  }),
);

/** Logging what a call cost must never cost the user their analysis. */
const recordUsage = (deckId: string | null): UsageSink => async (entry) => {
  console.log(
    `claude ${entry.kind}: ${entry.model} ${entry.inputTokens} in, ${entry.outputTokens} out, $${entry.costUsd?.toFixed(4) ?? "?"} in ${entry.durationMs}ms`,
  );
  await store.recordUsage({ ...entry, deckId }).catch((e) => console.error(`usage not recorded: ${e instanceof Error ? e.message : e}`));
};

const sendAnalyzeError = (res: express.Response, e: unknown, what: string) => {
  const status = e instanceof AnalyzeError ? e.status : 500;
  const message = e instanceof Error ? e.message : String(e);
  console.error(`${what} failed (${status}): ${message}`);
  res.status(status).json({ error: message });
};

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(process.env.ANTHROPIC_API_KEY),
    model: model(),
    plan: currentPlan().id,
    director: currentPlan().director,
    hasDeepgram: Boolean(process.env.DEEPGRAM_API_KEY),
  });
});

app.post("/api/analyze", async (req, res) => {
  const { image, deckId, slideIndex, facts } = req.body ?? {};
  if (typeof image !== "string" || !image.startsWith("data:image/")) {
    res.status(400).json({ error: "Body must be { image: <data URL>, deckId?, slideIndex?, facts? }" });
    return;
  }
  try {
    const deck = typeof deckId === "string" ? await store.deck(deckId) : null;
    const slide = currentPlan().director ? deck?.plan?.slides.find((s) => s.index === slideIndex) : undefined;
    const regions = await analyzeSlide(image, {
      slideIndex: typeof slideIndex === "number" ? slideIndex : null,
      plan: slide && deck?.plan ? { summary: deck.plan.summary, slide } : undefined,
      facts: SlideFactsSchema.safeParse(facts).data,
      onUsage: recordUsage(deck?.id ?? null),
    });
    res.json({ regions });
  } catch (e) {
    sendAnalyzeError(res, e, "analyze");
  }
});

app.post("/api/analyze/region", async (req, res) => {
  const { image, label, deckId, slideIndex, notes } = req.body ?? {};
  const cue = CueSchema.safeParse(req.body?.cue);
  if (typeof image !== "string" || !image.startsWith("data:image/") || typeof label !== "string" || !label.trim() || !cue.success) {
    res.status(400).json({ error: "Body must be { image: <data URL>, label, cue, deckId?, slideIndex?, notes? }" });
    return;
  }
  try {
    const deck = typeof deckId === "string" ? await store.deck(deckId) : null;
    res.json(
      await describeRegion(
        image,
        label.slice(0, 200),
        cue.data,
        typeof notes === "string" ? notes.slice(0, 4000) : undefined,
        typeof slideIndex === "number" ? slideIndex : null,
        recordUsage(deck?.id ?? null),
      ),
    );
  } catch (e) {
    sendAnalyzeError(res, e, "describe region");
  }
});

app.post("/api/decks/:id/plan", async (req, res) => {
  const body = DeckPlanRequestSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "Body must be { images: <data URL>[] }" });
  if (!currentPlan().director) return void res.status(409).json({ error: "Whole-deck planning isn't part of this plan." });
  try {
    if (!(await store.deck(req.params.id))) return void res.status(404).json({ error: "Presentation not found" });
    const plan = await planDeck(body.data.images, body.data.facts, recordUsage(req.params.id));
    await store.patchDeck(req.params.id, { plan });
    res.json(plan);
  } catch (e) {
    sendAnalyzeError(res, e, "plan");
  }
});

/* ---------- cue chat: customize a slide's cues in plain words ---------- */

app.post("/api/decks/:id/cues/chat", async (req, res) => {
  const body = CueChatRequestSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid request" });
  try {
    const deck = await store.deck(req.params.id);
    if (!deck) return void res.status(404).json({ error: "Presentation not found" });
    res.json(await cueChat(deck, body.data, recordUsage(deck.id)));
  } catch (e) {
    sendAnalyzeError(res, e, "chat");
  }
});

/* ---------- robot rehearsal ---------- */

app.post("/api/decks/:id/rehearse/script", async (req, res) => {
  const body = DeckScriptRequestSchema.safeParse(req.body ?? {});
  if (!body.success) return void res.status(400).json({ error: "Body must be { notes?: string[] }" });
  try {
    const deck = await store.deck(req.params.id);
    if (!deck) return void res.status(404).json({ error: "Presentation not found" });
    res.json(await deckScript(deck, body.data.notes, recordUsage(deck.id)));
  } catch (e) {
    sendAnalyzeError(res, e, "rehearsal script");
  }
});

app.post("/api/decks/:id/rehearse/feedback", async (req, res) => {
  const body = DeckFeedbackRequestSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid request" });
  try {
    const deck = await store.deck(req.params.id);
    if (!deck) return void res.status(404).json({ error: "Presentation not found" });
    res.json(await deckFeedback(deck, body.data, recordUsage(deck.id)));
  } catch (e) {
    sendAnalyzeError(res, e, "rehearsal feedback");
  }
});

app.post("/api/shows/:id/rehearse/script", async (req, res) => {
  try {
    const show = await store.show(req.params.id);
    if (!show) return void res.status(404).json({ error: "Demo not found" });
    if (!show.beats.length) return void res.status(409).json({ error: "Teach this demo before rehearsing it." });
    res.json(await showScript(show, recordUsage(null)));
  } catch (e) {
    sendAnalyzeError(res, e, "rehearsal script");
  }
});

app.post("/api/shows/:id/rehearse/feedback", async (req, res) => {
  const body = ShowFeedbackRequestSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid request" });
  try {
    const show = await store.show(req.params.id);
    if (!show) return void res.status(404).json({ error: "Demo not found" });
    res.json(await showFeedback(show, body.data, recordUsage(null)));
  } catch (e) {
    sendAnalyzeError(res, e, "rehearsal feedback");
  }
});

app.post("/api/stt/session", async (req, res) => {
  const keyterms: unknown = req.body?.keyterms ?? [];
  if (!Array.isArray(keyterms) || !keyterms.every((k) => typeof k === "string")) {
    res.status(400).json({ error: "Body must be { keyterms: string[] }" });
    return;
  }
  try {
    res.json(await createSttSession(keyterms));
  } catch (e) {
    const status = e instanceof SttError ? e.status : 502;
    const message = e instanceof Error ? e.message : String(e);
    console.error(`stt session failed (${status}): ${message}`);
    res.status(status).json({ error: message });
  }
});

const port = Number(process.env.PORT) || 8787;
app.listen(port, (err) => {
  if (err) throw err;
  const k = (v?: string) => (v ? "set" : "MISSING");
  console.log(
    `Stage API on http://localhost:${port} (Claude key ${k(process.env.ANTHROPIC_API_KEY)}, Deepgram key ${k(process.env.DEEPGRAM_API_KEY)}, data in ${store.where})`,
  );
});

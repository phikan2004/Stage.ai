import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import { AnalyzeError, analyzeSlide, DEFAULT_MODEL } from "./analyze.ts";
import { libraryRouter } from "./library.ts";
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

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use("/api", libraryRouter(store));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(process.env.ANTHROPIC_API_KEY),
    model: process.env.VISION_MODEL || DEFAULT_MODEL,
    hasDeepgram: Boolean(process.env.DEEPGRAM_API_KEY),
  });
});

app.post("/api/analyze", async (req, res) => {
  const image = req.body?.image;
  if (typeof image !== "string" || !image.startsWith("data:image/")) {
    res.status(400).json({ error: "Body must be { image: <data URL> }" });
    return;
  }
  const started = Date.now();
  try {
    const regions = await analyzeSlide(image);
    console.log(`analyzed slide: ${regions.length} regions in ${Date.now() - started}ms`);
    res.json({ regions });
  } catch (e) {
    const status = e instanceof AnalyzeError ? e.status : 500;
    const message = e instanceof Error ? e.message : String(e);
    console.error(`analyze failed (${status}): ${message}`);
    res.status(status).json({ error: message });
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
    `Producer API on http://localhost:${port} (Claude key ${k(process.env.ANTHROPIC_API_KEY)}, Deepgram key ${k(process.env.DEEPGRAM_API_KEY)}, data in ${store.where})`,
  );
});

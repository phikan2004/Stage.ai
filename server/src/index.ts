import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import { AnalyzeError, analyzeSlide, DEFAULT_MODEL } from "./analyze.ts";
import { libraryRouter } from "./library.ts";
import { Store } from "./store.ts";
import { attachSttRelay } from "./stt.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: join(root, ".env"), quiet: true, override: true });

const store = new Store(process.env.DATA_DIR || join(root, "data"));
await store.load();

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

const port = Number(process.env.PORT) || 8787;
const server = app.listen(port, () => {
  const k = (v?: string) => (v ? "set" : "MISSING");
  console.log(
    `Producer API on http://localhost:${port} (Claude key ${k(process.env.ANTHROPIC_API_KEY)}, Deepgram key ${k(process.env.DEEPGRAM_API_KEY)}, data in ${store.dir})`,
  );
});
attachSttRelay(server);

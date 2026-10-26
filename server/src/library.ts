import express, { type Response } from "express";
import { z } from "zod";
import { DeckPatchSchema, MatterSchema, RunInputSchema } from "../../shared/schema.ts";
import type { Store } from "./store.ts";

const NameBody = z.object({ name: MatterSchema.shape.name });

const notFound = (res: Response, what: string) => res.status(404).json({ error: `${what} not found` });
const badRequest = (res: Response, error: z.ZodError) =>
  res.status(400).json({ error: error.issues[0]?.message ?? "Invalid request" });

/** /api routes for matters, decks (PDF + regions + thumbnail) and presentation runs. */
export function libraryRouter(store: Store) {
  const r = express.Router();

  r.get("/home", (_req, res) => {
    res.json(store.home());
  });

  /* ---------- matters ---------- */

  r.post("/matters", async (req, res) => {
    const body = NameBody.safeParse(req.body);
    if (!body.success) return void badRequest(res, body.error);
    res.status(201).json(await store.createMatter(body.data.name));
  });

  r.get("/matters/:id", (req, res) => {
    const m = store.matter(req.params.id);
    if (!m) return void notFound(res, "Matter");
    res.json(m);
  });

  r.patch("/matters/:id", async (req, res) => {
    const body = NameBody.safeParse(req.body);
    if (!body.success) return void badRequest(res, body.error);
    const m = await store.renameMatter(req.params.id, body.data.name);
    if (!m) return void notFound(res, "Matter");
    res.json(m);
  });

  r.delete("/matters/:id", async (req, res) => {
    if (!(await store.deleteMatter(req.params.id))) return void notFound(res, "Matter");
    res.status(204).end();
  });

  /* ---------- decks ---------- */

  // Body is the raw PDF; ?name=deck.pdf&slides=12 (the browser has already rendered it, so it knows the count).
  r.post("/matters/:id/decks", express.raw({ type: "application/pdf", limit: "200mb" }), async (req, res) => {
    const name = String(req.query.name ?? "").trim() || "Untitled.pdf";
    const slides = Number(req.query.slides);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return void res.status(400).json({ error: "Body must be a PDF" });
    if (!Number.isInteger(slides) || slides < 1) return void res.status(400).json({ error: "?slides must be a positive integer" });
    const d = await store.createDeck(req.params.id, name, req.body, slides);
    if (!d) return void notFound(res, "Matter");
    res.status(201).json(d);
  });

  r.get("/decks/:id", (req, res) => {
    const d = store.deck(req.params.id);
    if (!d) return void notFound(res, "Presentation");
    res.json(d);
  });

  r.patch("/decks/:id", async (req, res) => {
    const body = DeckPatchSchema.safeParse(req.body);
    if (!body.success) return void badRequest(res, body.error);
    const d = await store.patchDeck(req.params.id, body.data);
    if (!d) return void notFound(res, "Presentation");
    res.json(d);
  });

  r.delete("/decks/:id", async (req, res) => {
    if (!(await store.deleteDeck(req.params.id))) return void notFound(res, "Presentation");
    res.status(204).end();
  });

  r.get("/decks/:id/pdf", (req, res) => {
    if (!store.deck(req.params.id)) return void notFound(res, "Presentation");
    res.type("application/pdf").sendFile(store.pdfPath(req.params.id));
  });

  r.put("/decks/:id/thumb", express.raw({ type: "image/jpeg", limit: "5mb" }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return void res.status(400).json({ error: "Body must be a JPEG" });
    if (!(await store.setThumb(req.params.id, req.body))) return void notFound(res, "Presentation");
    res.status(204).end();
  });

  r.get("/decks/:id/thumb", (req, res) => {
    if (!store.deck(req.params.id)?.hasThumb) return void notFound(res, "Thumbnail");
    res.set("cache-control", "no-cache").type("image/jpeg").sendFile(store.thumbPath(req.params.id));
  });

  /* ---------- runs ---------- */

  r.post("/runs", async (req, res) => {
    const body = RunInputSchema.safeParse(req.body);
    if (!body.success) return void badRequest(res, body.error);
    const run = await store.addRun(body.data);
    if (!run) return void notFound(res, "Presentation");
    console.log(`saved run ${run.id}: ${Math.round(run.stats.durationMs / 1000)}s, ${run.stats.zooms} zooms`);
    res.status(201).json({ id: run.id });
  });

  r.get("/runs/:id", (req, res) => {
    const run = store.run(req.params.id);
    if (!run) return void notFound(res, "Run");
    res.json(run);
  });

  r.delete("/runs/:id", async (req, res) => {
    if (!(await store.deleteRun(req.params.id))) return void notFound(res, "Run");
    res.status(204).end();
  });

  return r;
}

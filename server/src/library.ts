import express, { type Response } from "express";
import { z } from "zod";
import { DeckCreateSchema, DeckPatchSchema, MatterSchema, RunInputSchema } from "../../shared/schema.ts";
import { UploadMissingError, type Library } from "./store.ts";

const NameBody = z.object({ name: MatterSchema.shape.name });

const notFound = (res: Response, what: string) => res.status(404).json({ error: `${what} not found` });
const badRequest = (res: Response, error: z.ZodError) =>
  res.status(400).json({ error: error.issues[0]?.message ?? "Invalid request" });

/** /api routes for matters, decks (PDF + regions + thumbnail) and presentation runs. */
export function libraryRouter(store: Library) {
  const r = express.Router();

  r.get("/home", async (_req, res) => {
    res.json(await store.home());
  });

  /* ---------- matters ---------- */

  r.post("/matters", async (req, res) => {
    const body = NameBody.safeParse(req.body);
    if (!body.success) return void badRequest(res, body.error);
    res.status(201).json(await store.createMatter(body.data.name));
  });

  r.get("/matters/:id", async (req, res) => {
    const m = await store.matter(req.params.id);
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

  // A new deck: get an upload url, PUT the PDF there, then register it with POST /matters/:id/decks.
  r.post("/matters/:id/decks/upload", async (req, res) => {
    const upload = await store.prepareUpload(req.params.id);
    if (!upload) return void notFound(res, "Matter");
    res.status(201).json(upload);
  });

  r.post("/matters/:id/decks", async (req, res) => {
    const body = DeckCreateSchema.safeParse(req.body);
    if (!body.success) return void badRequest(res, body.error);
    try {
      const d = await store.createDeck(req.params.id, body.data);
      if (!d) return void notFound(res, "Matter");
      res.status(201).json(d);
    } catch (e) {
      if (!(e instanceof UploadMissingError)) throw e;
      res.status(409).json({ error: e.message });
    }
  });

  // Local storage only; with Supabase the upload url points straight at Storage.
  r.put("/uploads/:deckId", express.raw({ type: "application/pdf", limit: "200mb" }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return void res.status(400).json({ error: "Body must be a PDF" });
    if (!(await store.receiveUpload?.(req.params.deckId, req.body))) return void notFound(res, "Upload");
    res.status(204).end();
  });

  r.get("/decks/:id", async (req, res) => {
    const d = await store.deck(req.params.id);
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

  r.get("/decks/:id/pdf", async (req, res) => {
    const pdf = await store.pdf(req.params.id);
    if (!pdf) return void notFound(res, "Presentation");
    if ("url" in pdf) return void res.redirect(pdf.url);
    res.type("application/pdf").send(pdf.data);
  });

  r.put("/decks/:id/thumb", express.raw({ type: "image/jpeg", limit: "5mb" }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return void res.status(400).json({ error: "Body must be a JPEG" });
    if (!(await store.setThumb(req.params.id, req.body))) return void notFound(res, "Presentation");
    res.status(204).end();
  });

  r.get("/decks/:id/thumb", async (req, res) => {
    const jpeg = await store.thumb(req.params.id);
    if (!jpeg) return void notFound(res, "Thumbnail");
    res.set("cache-control", "no-cache").type("image/jpeg").send(jpeg);
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

  r.get("/runs/:id", async (req, res) => {
    const run = await store.run(req.params.id);
    if (!run) return void notFound(res, "Run");
    res.json(run);
  });

  r.delete("/runs/:id", async (req, res) => {
    if (!(await store.deleteRun(req.params.id))) return void notFound(res, "Run");
    res.status(204).end();
  });

  return r;
}

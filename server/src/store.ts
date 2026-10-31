import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  summarizeRun,
  type DeckDetail,
  type DeckPatch,
  type DeckRecord,
  type DeckSummary,
  type HomeData,
  type Matter,
  type MatterDetail,
  type MatterSummary,
  type Run,
  type RunDetail,
  type RunInput,
  type RunSummary,
} from "../../shared/schema.ts";

/** Storage behind the /api routes. FileStore (local JSON) or SupabaseStore (Postgres + Storage). */
export interface Library {
  /** human-readable location, for the startup log */
  readonly where: string;
  home(): Promise<HomeData>;
  matter(id: string): Promise<MatterDetail | null>;
  deck(id: string): Promise<DeckDetail | null>;
  run(id: string): Promise<RunDetail | null>;
  pdf(deckId: string): Promise<Buffer | null>;
  thumb(deckId: string): Promise<Buffer | null>;
  createMatter(name: string): Promise<Matter>;
  renameMatter(id: string, name: string): Promise<Matter | null>;
  deleteMatter(id: string): Promise<boolean>;
  createDeck(matterId: string, name: string, pdf: Buffer, slideCount: number): Promise<DeckRecord | null>;
  patchDeck(id: string, patch: DeckPatch): Promise<DeckRecord | null>;
  setThumb(id: string, jpeg: Buffer): Promise<boolean>;
  deleteDeck(id: string): Promise<boolean>;
  addRun(input: RunInput): Promise<Run | null>;
  deleteRun(id: string): Promise<boolean>;
}

interface Db {
  version: 1;
  matters: Matter[];
  decks: DeckRecord[];
  runs: Run[];
}

const newId = () => randomBytes(6).toString("base64url");
const byRecent = <T extends { updatedAt: number }>(a: T, b: T) => b.updatedAt - a.updatedAt;
const RECENT_RUNS = 25;

/**
 * Everything lives in one JSON file plus a folder per deck (PDF + thumbnail). The fallback when Supabase isn't
 * configured; writes are serialized and atomic (temp file + rename).
 */
export class FileStore implements Library {
  private db: Db = { version: 1, matters: [], decks: [], runs: [] };
  private writing: Promise<void> = Promise.resolve();

  constructor(readonly dir: string) {}

  get where() {
    return this.dir;
  }

  private get dbPath() {
    return join(this.dir, "db.json");
  }
  private deckDir(id: string) {
    return join(this.dir, "decks", id);
  }
  private pdfPath(id: string) {
    return join(this.deckDir(id), "deck.pdf");
  }
  private thumbPath(id: string) {
    return join(this.deckDir(id), "thumb.jpg");
  }

  async load(): Promise<void> {
    await mkdir(join(this.dir, "decks"), { recursive: true });
    try {
      this.db = { ...this.db, ...JSON.parse(await readFile(this.dbPath, "utf8")) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  private save(): Promise<void> {
    const text = JSON.stringify(this.db, null, 1);
    this.writing = this.writing
      .then(async () => {
        const tmp = `${this.dbPath}.tmp`;
        await writeFile(tmp, text);
        await rename(tmp, this.dbPath);
      })
      .catch((e) => console.error("store: write failed", e));
    return this.writing;
  }

  private touchMatter(id: string, at = Date.now()) {
    const m = this.db.matters.find((x) => x.id === id);
    if (m) m.updatedAt = at;
  }

  /* ---------- read models ---------- */

  private runSummary(r: Run): RunSummary {
    const { events: _events, ...rest } = r;
    return { ...rest, matterName: this.db.matters.find((m) => m.id === r.matterId)?.name ?? "Deleted matter" };
  }

  private deckSummary(d: DeckRecord): DeckSummary {
    const { slides, ...rest } = d;
    const runs = this.db.runs.filter((r) => r.deckId === d.id);
    return {
      ...rest,
      regionCount: slides.reduce((n, s) => n + s.regions.length, 0),
      runCount: runs.length,
      lastRunAt: runs.length ? Math.max(...runs.map((r) => r.startedAt)) : null,
    };
  }

  private recentRuns(filter: (r: Run) => boolean = () => true, limit = RECENT_RUNS): RunSummary[] {
    return this.db.runs
      .filter(filter)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map((r) => this.runSummary(r));
  }

  async home(): Promise<HomeData> {
    const matters: MatterSummary[] = [...this.db.matters].sort(byRecent).map((m) => {
      const decks = this.db.decks.filter((d) => d.matterId === m.id).sort(byRecent);
      const runs = this.db.runs.filter((r) => r.matterId === m.id);
      return {
        ...m,
        deckCount: decks.length,
        runCount: runs.length,
        lastRunAt: runs.length ? Math.max(...runs.map((r) => r.startedAt)) : null,
        thumbDeckId: decks.find((d) => d.hasThumb)?.id ?? null,
      };
    });
    return { matters, runs: this.recentRuns() };
  }

  async matter(id: string): Promise<MatterDetail | null> {
    const matter = this.db.matters.find((m) => m.id === id);
    if (!matter) return null;
    return {
      matter,
      decks: this.db.decks
        .filter((d) => d.matterId === id)
        .sort(byRecent)
        .map((d) => this.deckSummary(d)),
      runs: this.recentRuns((r) => r.matterId === id, 200),
    };
  }

  async deck(id: string): Promise<DeckDetail | null> {
    const d = this.db.decks.find((x) => x.id === id);
    if (!d) return null;
    return { ...d, matterName: this.db.matters.find((m) => m.id === d.matterId)?.name ?? "" };
  }

  async run(id: string): Promise<RunDetail | null> {
    const r = this.db.runs.find((x) => x.id === id);
    if (!r) return null;
    return { ...this.runSummary(r), events: r.events, deckExists: this.db.decks.some((d) => d.id === r.deckId) };
  }

  async pdf(id: string): Promise<Buffer | null> {
    if (!this.db.decks.some((d) => d.id === id)) return null;
    return readFile(this.pdfPath(id));
  }

  async thumb(id: string): Promise<Buffer | null> {
    if (!this.db.decks.find((d) => d.id === id)?.hasThumb) return null;
    return readFile(this.thumbPath(id));
  }

  /* ---------- writes ---------- */

  async createMatter(name: string): Promise<Matter> {
    const now = Date.now();
    const m: Matter = { id: newId(), name, createdAt: now, updatedAt: now };
    this.db.matters.push(m);
    await this.save();
    return m;
  }

  async renameMatter(id: string, name: string): Promise<Matter | null> {
    const m = this.db.matters.find((x) => x.id === id);
    if (!m) return null;
    m.name = name;
    m.updatedAt = Date.now();
    await this.save();
    return m;
  }

  async deleteMatter(id: string): Promise<boolean> {
    if (!this.db.matters.some((m) => m.id === id)) return false;
    const deckIds = this.db.decks.filter((d) => d.matterId === id).map((d) => d.id);
    this.db.matters = this.db.matters.filter((m) => m.id !== id);
    this.db.decks = this.db.decks.filter((d) => d.matterId !== id);
    this.db.runs = this.db.runs.filter((r) => r.matterId !== id);
    await this.save();
    await Promise.all(deckIds.map((d) => rm(this.deckDir(d), { recursive: true, force: true })));
    return true;
  }

  async createDeck(matterId: string, name: string, pdf: Buffer, slideCount: number): Promise<DeckRecord | null> {
    if (!this.db.matters.some((m) => m.id === matterId)) return null;
    const now = Date.now();
    const d: DeckRecord = {
      id: newId(),
      matterId,
      name,
      pdfHash: createHash("sha256").update(pdf).digest("hex"),
      slideCount,
      slides: Array.from({ length: slideCount }, (_, index) => ({ index, regions: [] })),
      analyzed: false,
      hasThumb: false,
      createdAt: now,
      updatedAt: now,
    };
    await mkdir(this.deckDir(d.id), { recursive: true });
    await writeFile(this.pdfPath(d.id), pdf);
    this.db.decks.push(d);
    this.touchMatter(matterId, now);
    await this.save();
    return d;
  }

  async patchDeck(id: string, patch: DeckPatch): Promise<DeckRecord | null> {
    const d = this.db.decks.find((x) => x.id === id);
    if (!d) return null;
    if (patch.name !== undefined) d.name = patch.name;
    if (patch.slides !== undefined) d.slides = patch.slides;
    if (patch.analyzed !== undefined) d.analyzed = patch.analyzed;
    d.updatedAt = Date.now();
    this.touchMatter(d.matterId, d.updatedAt);
    await this.save();
    return d;
  }

  async setThumb(id: string, jpeg: Buffer): Promise<boolean> {
    const d = this.db.decks.find((x) => x.id === id);
    if (!d) return false;
    await writeFile(this.thumbPath(id), jpeg);
    d.hasThumb = true;
    await this.save();
    return true;
  }

  /** Deletes the deck, its files, and its runs. */
  async deleteDeck(id: string): Promise<boolean> {
    const d = this.db.decks.find((x) => x.id === id);
    if (!d) return false;
    this.db.decks = this.db.decks.filter((x) => x.id !== id);
    this.db.runs = this.db.runs.filter((r) => r.deckId !== id);
    this.touchMatter(d.matterId);
    await this.save();
    await rm(this.deckDir(id), { recursive: true, force: true });
    return true;
  }

  async addRun(input: RunInput): Promise<Run | null> {
    const d = this.db.decks.find((x) => x.id === input.deckId);
    if (!d) return null;
    const run: Run = {
      ...input,
      id: newId(),
      matterId: d.matterId,
      deckName: d.name,
      slideCount: d.slideCount,
      stats: summarizeRun(input),
    };
    this.db.runs.push(run);
    this.touchMatter(d.matterId, input.endedAt);
    await this.save();
    return run;
  }

  async deleteRun(id: string): Promise<boolean> {
    const before = this.db.runs.length;
    this.db.runs = this.db.runs.filter((r) => r.id !== id);
    if (this.db.runs.length === before) return false;
    await this.save();
    return true;
  }
}

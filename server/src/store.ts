import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  summarizeRun,
  type DeckCreate,
  type DeckDetail,
  type DeckFormat,
  type DeckMode,
  type DeckPatch,
  type DeckRecord,
  type DeckSummary,
  type DeckUpload,
  type HomeData,
  type Matter,
  type MatterDetail,
  type MatterSummary,
  type Run,
  type RunDetail,
  type RunInput,
  type RunSummary,
  type Show,
  type ShowPatch,
  type UsageEntry,
  type UsageSummary,
} from "../../shared/schema.ts";

/** createDeck was called before the file reached the upload url. */
export class UploadMissingError extends Error {
  constructor() {
    super("The upload didn't arrive. Try adding the presentation again.");
  }
}

/** A deck or demo was moved to a project that doesn't exist. */
export class MatterNotFoundError extends Error {
  constructor() {
    super("That project no longer exists.");
  }
}

/** A deck was added or moved to a one-presentation matter that already has its presentation. */
export class MatterFullError extends Error {
  constructor() {
    super("This matter holds one presentation. Delete it to add a different one.");
  }
}

/** A deck's file is either served from here (local) or fetched straight from storage via a temporary url. */
export type DeckFileSource = { url: string } | { data: Buffer };

/**
 * Storage behind the /api routes. FileStore (local JSON) or SupabaseStore (Postgres + Storage).
 * Deck files move directly between the browser and storage: serverless hosts cap requests at 4.5 MB.
 */
export interface Library {
  /** human-readable location, for the startup log */
  readonly where: string;
  home(): Promise<HomeData>;
  matter(id: string): Promise<MatterDetail | null>;
  deck(id: string): Promise<DeckDetail | null>;
  run(id: string): Promise<RunDetail | null>;
  deckFile(deckId: string): Promise<DeckFileSource | null>;
  thumb(deckId: string): Promise<Buffer | null>;
  createMatter(name: string, deckMode: DeckMode, solo: boolean): Promise<Matter>;
  renameMatter(id: string, name: string): Promise<Matter | null>;
  deleteMatter(id: string): Promise<boolean>;
  /** Reserves a deck id and says where to send its file; null if the matter doesn't exist. */
  prepareUpload(matterId: string, format: DeckFormat): Promise<DeckUpload | null>;
  /** Only stores that upload through /api/uploads implement this. */
  receiveUpload?(deckId: string, file: Buffer): Promise<boolean>;
  createDeck(matterId: string, deck: DeckCreate): Promise<DeckRecord | null>;
  patchDeck(id: string, patch: DeckPatch): Promise<DeckRecord | null>;
  setThumb(id: string, jpeg: Buffer): Promise<boolean>;
  deleteDeck(id: string): Promise<boolean>;
  addRun(input: RunInput): Promise<Run | null>;
  deleteRun(id: string): Promise<boolean>;
  /** Deletes runs (and their transcripts) that started before `before`; returns how many. */
  expireRuns(before: number): Promise<number>;
  shows(matterId: string): Promise<Show[] | null>;
  allShows(): Promise<Show[]>;
  show(id: string): Promise<Show | null>;
  createShow(matterId: string, name: string): Promise<Show | null>;
  patchShow(id: string, patch: ShowPatch): Promise<Show | null>;
  deleteShow(id: string): Promise<boolean>;
  recordUsage(entry: UsageEntry): Promise<void>;
  deckUsage(deckId: string): Promise<UsageSummary>;
}

interface Db {
  version: 1;
  matters: Matter[];
  decks: DeckRecord[];
  runs: Run[];
  shows: Show[];
  usage: UsageEntry[];
}

const newId = () => randomBytes(6).toString("base64url");
const byRecent = <T extends { updatedAt: number }>(a: T, b: T) => b.updatedAt - a.updatedAt;
const RECENT_RUNS = 25;

/**
 * Everything lives in one JSON file plus a folder per deck (file + thumbnail). The fallback when Supabase isn't
 * configured; writes are serialized and atomic (temp file + rename).
 */
export class FileStore implements Library {
  private db: Db = { version: 1, matters: [], decks: [], runs: [], shows: [], usage: [] };
  private writing: Promise<void> = Promise.resolve();
  /** ids handed out by prepareUpload; the only ids /api/uploads may write to */
  private pending = new Map<string, DeckFormat>();

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
  private filePath(id: string, format: DeckFormat) {
    return join(this.deckDir(id), `deck.${format}`);
  }
  private thumbPath(id: string) {
    return join(this.deckDir(id), "thumb.jpg");
  }

  async load(): Promise<void> {
    await mkdir(join(this.dir, "decks"), { recursive: true });
    try {
      this.db = { ...this.db, ...JSON.parse(await readFile(this.dbPath, "utf8")) };
      for (const m of this.db.matters) {
        m.deckMode ??= "multiple";
        m.solo ??= false;
      }
      for (const s of this.db.shows) s.cover ??= null;
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
    const decks = [...this.db.decks].sort(byRecent).map((d) => this.deckSummary(d));
    return { matters, decks, runs: this.recentRuns() };
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
    const m = this.db.matters.find((x) => x.id === d.matterId);
    return { ...d, matterName: m?.name ?? "", matterSolo: m?.solo ?? false };
  }

  async run(id: string): Promise<RunDetail | null> {
    const r = this.db.runs.find((x) => x.id === id);
    if (!r) return null;
    return { ...this.runSummary(r), events: r.events, deckExists: this.db.decks.some((d) => d.id === r.deckId) };
  }

  async deckFile(id: string): Promise<DeckFileSource | null> {
    if (!this.db.decks.some((d) => d.id === id)) return null;
    const format = (await stat(this.filePath(id, "pptx")).catch(() => null)) ? "pptx" : "pdf";
    return { data: await readFile(this.filePath(id, format)) };
  }

  async thumb(id: string): Promise<Buffer | null> {
    if (!this.db.decks.find((d) => d.id === id)?.hasThumb) return null;
    return readFile(this.thumbPath(id));
  }

  /* ---------- writes ---------- */

  async createMatter(name: string, deckMode: DeckMode, solo: boolean): Promise<Matter> {
    const now = Date.now();
    const m: Matter = { id: newId(), name, deckMode, solo, createdAt: now, updatedAt: now };
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
    this.db.shows = this.db.shows.filter((x) => x.matterId !== id);
    await this.save();
    await Promise.all(deckIds.map((d) => rm(this.deckDir(d), { recursive: true, force: true })));
    return true;
  }

  async prepareUpload(matterId: string, format: DeckFormat): Promise<DeckUpload | null> {
    const matter = this.db.matters.find((m) => m.id === matterId);
    if (!matter) return null;
    if (matter.deckMode === "single" && this.db.decks.some((d) => d.matterId === matterId)) throw new MatterFullError();
    const deckId = newId();
    this.pending.set(deckId, format);
    return { deckId, url: `/api/uploads/${deckId}` };
  }

  async receiveUpload(deckId: string, file: Buffer): Promise<boolean> {
    const format = this.pending.get(deckId);
    if (!format) return false;
    await mkdir(this.deckDir(deckId), { recursive: true });
    await writeFile(this.filePath(deckId, format), file);
    return true;
  }

  async createDeck(matterId: string, { deckId, name, format, pdfHash, slideCount }: DeckCreate): Promise<DeckRecord | null> {
    if (!this.db.matters.some((m) => m.id === matterId)) return null;
    if (this.pending.get(deckId) !== format || !(await stat(this.filePath(deckId, format)).catch(() => null))) throw new UploadMissingError();
    this.pending.delete(deckId);
    const now = Date.now();
    const d: DeckRecord = {
      id: deckId,
      matterId,
      name,
      pdfHash,
      slideCount,
      slides: Array.from({ length: slideCount }, (_, index) => ({ index, regions: [] })),
      analyzed: false,
      hasThumb: false,
      createdAt: now,
      updatedAt: now,
    };
    this.db.decks.push(d);
    this.touchMatter(matterId, now);
    await this.save();
    return d;
  }

  async patchDeck(id: string, patch: DeckPatch): Promise<DeckRecord | null> {
    const d = this.db.decks.find((x) => x.id === id);
    if (!d) return null;
    if (patch.matterId !== undefined && patch.matterId !== d.matterId) {
      this.checkTarget(patch.matterId, true);
      const from = d.matterId;
      d.matterId = patch.matterId;
      for (const r of this.db.runs) if (r.deckId === id) r.matterId = patch.matterId;
      this.dropIfEmptySolo(from);
    }
    if (patch.name !== undefined) d.name = patch.name;
    if (patch.slides !== undefined) d.slides = patch.slides;
    if (patch.analyzed !== undefined) d.analyzed = patch.analyzed;
    if (patch.plan !== undefined) d.plan = patch.plan;
    d.updatedAt = Date.now();
    this.touchMatter(d.matterId, d.updatedAt);
    await this.save();
    return d;
  }

  /** Throws if the project can't take a deck (or a demo) right now. */
  private checkTarget(matterId: string, isDeck: boolean) {
    const m = this.db.matters.find((x) => x.id === matterId);
    if (!m) throw new MatterNotFoundError();
    if (isDeck && m.deckMode === "single" && this.db.decks.some((d) => d.matterId === matterId)) throw new MatterFullError();
  }

  /** A hidden solo matter that no longer holds anything goes away with its last item. */
  private dropIfEmptySolo(matterId: string) {
    const m = this.db.matters.find((x) => x.id === matterId);
    if (!m?.solo) return;
    if (this.db.decks.some((d) => d.matterId === matterId) || this.db.shows.some((x) => x.matterId === matterId)) return;
    this.db.matters = this.db.matters.filter((x) => x.id !== matterId);
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

  async recordUsage(entry: UsageEntry): Promise<void> {
    this.db.usage.push(entry);
    await this.save();
  }

  async deckUsage(deckId: string): Promise<UsageSummary> {
    const sum: UsageSummary = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
    for (const u of this.db.usage) {
      if (u.deckId !== deckId) continue;
      sum.calls++;
      sum.inputTokens += u.inputTokens;
      sum.outputTokens += u.outputTokens;
      sum.cacheReadTokens += u.cacheReadTokens;
      sum.cacheWriteTokens += u.cacheWriteTokens;
      sum.costUsd += u.costUsd ?? 0;
    }
    return sum;
  }

  async deleteRun(id: string): Promise<boolean> {
    const before = this.db.runs.length;
    this.db.runs = this.db.runs.filter((r) => r.id !== id);
    if (this.db.runs.length === before) return false;
    await this.save();
    return true;
  }

  async expireRuns(before: number): Promise<number> {
    const kept = this.db.runs.filter((r) => r.startedAt >= before);
    const gone = this.db.runs.length - kept.length;
    if (!gone) return 0;
    this.db.runs = kept;
    await this.save();
    return gone;
  }

  /* ---------- shows ---------- */

  async shows(matterId: string): Promise<Show[] | null> {
    if (!this.db.matters.some((m) => m.id === matterId)) return null;
    return this.db.shows.filter((x) => x.matterId === matterId).sort(byRecent);
  }

  async allShows(): Promise<Show[]> {
    return [...this.db.shows].sort(byRecent);
  }

  async show(id: string): Promise<Show | null> {
    return this.db.shows.find((x) => x.id === id) ?? null;
  }

  async createShow(matterId: string, name: string): Promise<Show | null> {
    if (!this.db.matters.some((m) => m.id === matterId)) return null;
    const now = Date.now();
    const show: Show = { id: newId(), matterId, name, beats: [], limits: { apps: [], origins: [], commands: [], actions: [] }, recordingId: null, cover: null, dryRuns: [], createdAt: now, updatedAt: now };
    this.db.shows.push(show);
    this.touchMatter(matterId, now);
    await this.save();
    return show;
  }

  async patchShow(id: string, patch: ShowPatch): Promise<Show | null> {
    const show = this.db.shows.find((x) => x.id === id);
    if (!show) return null;
    if (patch.matterId !== undefined && patch.matterId !== show.matterId) {
      this.checkTarget(patch.matterId, false);
      const from = show.matterId;
      show.matterId = patch.matterId;
      this.dropIfEmptySolo(from);
    }
    const { matterId: _moved, ...fields } = patch;
    Object.assign(show, fields, { updatedAt: Date.now() });
    this.touchMatter(show.matterId, show.updatedAt);
    await this.save();
    return show;
  }

  async deleteShow(id: string): Promise<boolean> {
    if (!this.db.shows.some((x) => x.id === id)) return false;
    this.db.shows = this.db.shows.filter((x) => x.id !== id);
    await this.save();
    return true;
  }
}

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import {
  normalizeRegions,
  summarizeRun,
  type DeckCreate,
  type Box,
  type Cue,
  type DeckDetail,
  type DeckFormat,
  type DeckMode,
  type DeckPatch,
  type DeckPlan,
  type DeckRecord,
  type DeckSummary,
  type DeckUpload,
  type HomeData,
  type Matter,
  type MatterDetail,
  type Region,
  type Run,
  type RunDetail,
  type RunEvent,
  type RunInput,
  type RunSummary,
  type Show,
  type ShowPatch,
  type Slide,
  type UsageEntry,
  type UsageSummary,
} from "../../shared/schema.ts";
import { MatterFullError, MatterNotFoundError, UploadMissingError, type DeckFileSource, type Library } from "./store.ts";

/** Where deck files and thumbnails go. Supabase Storage in production; swappable for tests. */
export interface BlobStore {
  put(path: string, data: Buffer, contentType: string): Promise<void>;
  get(path: string): Promise<Buffer | null>;
  exists(path: string): Promise<boolean>;
  /** Temporary url the browser can PUT a new file to. */
  uploadUrl(path: string): Promise<string>;
  /** Temporary url the browser can GET a file from. */
  downloadUrl(path: string): Promise<string>;
  remove(paths: string[]): Promise<void>;
}

export const BUCKET = "producer-decks";
const DOWNLOAD_URL_TTL_S = 300;

export function supabaseBlobs(url: string, key: string, bucket = BUCKET): BlobStore {
  const storage = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }).storage.from(bucket);
  return {
    async put(path, data, contentType) {
      const { error } = await storage.upload(path, data, { contentType, upsert: true });
      if (error) throw new Error(`Storage upload failed for ${path}: ${error.message}`);
    },
    async get(path) {
      const { data, error } = await storage.download(path);
      if (error || !data) return null;
      return Buffer.from(await data.arrayBuffer());
    },
    async exists(path) {
      const { data } = await storage.exists(path);
      return Boolean(data);
    },
    async uploadUrl(path) {
      const { data, error } = await storage.createSignedUploadUrl(path);
      if (error) throw new Error(`Storage upload url failed for ${path}: ${error.message}`);
      return data.signedUrl;
    },
    async downloadUrl(path) {
      const { data, error } = await storage.createSignedUrl(path, DOWNLOAD_URL_TTL_S);
      if (error) throw new Error(`Storage download url failed for ${path}: ${error.message}`);
      return data.signedUrl;
    },
    async remove(paths) {
      if (paths.length === 0) return;
      const { error } = await storage.remove(paths);
      if (error) console.error(`Storage delete failed: ${error.message}`);
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids come from URLs; anything that isn't a uuid simply doesn't exist (rather than a Postgres cast error). */
const isId = (id: string) => UUID.test(id);
const ms = (d: Date | null) => (d ? d.getTime() : null);
const RECENT_RUNS = 25;
const deckPathFor = (deckId: string, format: DeckFormat) => `${deckId}/deck.${format}`;

/* Row shapes as they come back from Postgres (postgres.js: timestamptz → Date). */
interface MatterRow {
  id: string;
  name: string;
  deck_mode: DeckMode;
  solo: boolean;
  created_at: Date;
  updated_at: Date;
}
interface DeckRow {
  id: string;
  matter_id: string;
  name: string;
  pdf_hash: string;
  slide_count: number;
  analyzed: boolean;
  plan: DeckPlan | null;
  pdf_path: string;
  thumb_path: string | null;
  created_at: Date;
  updated_at: Date;
}
interface RegionRow {
  slide_index: number;
  region_key: string;
  label: string;
  description: string;
  keywords: string[];
  cue: Cue | null;
  phrases: string[];
  marks: Box[] | null;
  box_x: number;
  box_y: number;
  box_w: number;
  box_h: number;
}
interface RunRow {
  id: string;
  deck_id: string;
  deck_name: string;
  slide_count: number;
  engine: string | null;
  started_at: Date;
  ended_at: Date;
  slides_visited: number;
  zooms: number;
  commands: number;
  words: number;
  matter_id: string;
  matter_name: string;
}
interface EventRow {
  t_ms: number;
  type: RunEvent["type"];
  slide_index: number;
  region_key: string | null;
  label: string | null;
  cue: Cue | null;
  command: string | null;
  text: string | null;
  simulated: boolean;
}

const toMatter = (r: MatterRow): Matter => ({ id: r.id, name: r.name, deckMode: r.deck_mode, solo: r.solo, createdAt: ms(r.created_at)!, updatedAt: ms(r.updated_at)! });

function toDeckBase(r: DeckRow): Omit<DeckRecord, "slides"> {
  return {
    id: r.id,
    matterId: r.matter_id,
    name: r.name,
    pdfHash: r.pdf_hash,
    slideCount: r.slide_count,
    analyzed: r.analyzed,
    plan: r.plan,
    hasThumb: r.thumb_path !== null,
    createdAt: ms(r.created_at)!,
    updatedAt: ms(r.updated_at)!,
  };
}

function toSlides(slideCount: number, rows: RegionRow[]): Slide[] {
  const slides: Slide[] = Array.from({ length: slideCount }, (_, index) => ({ index, regions: [] }));
  for (const r of rows) {
    slides[r.slide_index]?.regions.push({
      id: r.region_key,
      label: r.label,
      description: r.description,
      keywords: r.keywords,
      box: { x: r.box_x, y: r.box_y, w: r.box_w, h: r.box_h },
      ...(r.cue ? { cue: r.cue } : {}),
      ...(r.phrases.length ? { phrases: r.phrases } : {}),
      ...(r.marks ? { marks: r.marks } : {}),
    });
  }
  return slides;
}

function toRunSummary(r: RunRow): RunSummary {
  return {
    id: r.id,
    deckId: r.deck_id,
    matterId: r.matter_id,
    matterName: r.matter_name,
    deckName: r.deck_name,
    slideCount: r.slide_count,
    engine: r.engine,
    startedAt: ms(r.started_at)!,
    endedAt: ms(r.ended_at)!,
    stats: {
      durationMs: r.ended_at.getTime() - r.started_at.getTime(),
      slidesVisited: r.slides_visited,
      zooms: r.zooms,
      commands: r.commands,
      words: r.words,
    },
  };
}

function toEvent(e: EventRow): RunEvent {
  const base = { t: e.t_ms, slide: e.slide_index };
  switch (e.type) {
    case "slide":
      return { ...base, type: "slide" };
    case "zoom":
      return { ...base, type: "zoom", regionId: e.region_key ?? "", label: e.label ?? "", ...(e.cue ? { cue: e.cue } : {}) };
    case "command":
      return { ...base, type: "command", command: e.command ?? "", text: e.text ?? "" };
    case "heard":
      return { ...base, type: "heard", text: e.text ?? "", ...(e.simulated ? { simulated: true } : {}) };
  }
}

function regionRows(slides: Slide[], slideCount: number) {
  return slides
    .filter((s) => s.index >= 0 && s.index < slideCount)
    .flatMap((s) =>
      normalizeRegions(s.regions).map((r: Region, position) => ({
        slide_index: s.index,
        position,
        region_key: r.id,
        label: r.label.trim().slice(0, 200) || "Region",
        description: r.description,
        keywords: r.keywords,
        cue: r.cue ?? null,
        phrases: r.phrases ?? [],
        marks: r.marks ?? null,
        box_x: r.box.x,
        box_y: r.box.y,
        box_w: r.box.w,
        box_h: r.box.h,
      })),
    );
}

/**
 * Runs statements one at a time, across concurrent requests too. Behind Supabase's transaction pooler, a query that
 * overlaps another on the same connection never gets an answer, and neither max_pipeline nor a larger pool prevents it.
 * Callers use the tag and begin(); inside a transaction, statements must be awaited in turn.
 */
function serialize(sql: postgres.Sql): postgres.Sql {
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(run: () => PromiseLike<T>): Promise<T> => {
    const result = tail.then(run);
    tail = result.catch(() => {});
    return result;
  };
  const tag = (strings: TemplateStringsArray, ...args: never[]) => enqueue(() => sql(strings, ...args));
  const begin = (fn: (tx: postgres.TransactionSql) => unknown) => enqueue(() => sql.begin(fn));
  return Object.assign(tag, { begin }) as unknown as postgres.Sql;
}

interface ShowRow {
  id: string;
  matter_id: string;
  name: string;
  beats: Show["beats"];
  limits: Show["limits"];
  recording_id: string | null;
  cover: string | null;
  dry_runs: Show["dryRuns"];
  created_at: Date;
  updated_at: Date;
}

type DeckSummaryRow = DeckRow & { region_count: number; run_count: number; last_run_at: Date | null };
const toDeckSummary = (d: DeckSummaryRow): DeckSummary => ({
  ...toDeckBase(d),
  regionCount: d.region_count,
  runCount: d.run_count,
  lastRunAt: ms(d.last_run_at),
});

const toShow = (r: ShowRow): Show => ({
  id: r.id,
  matterId: r.matter_id,
  name: r.name,
  beats: r.beats,
  limits: r.limits,
  recordingId: r.recording_id,
  cover: r.cover,
  dryRuns: r.dry_runs,
  createdAt: r.created_at.getTime(),
  updatedAt: r.updated_at.getTime(),
});

/**
 * Matters, decks, regions and runs in the `producer` Postgres schema (see supabase/migrations), deck files and thumbnails
 * in Supabase Storage. Connects directly to Postgres, so the schema never has to be exposed through the Data API.
 */
export class SupabaseStore implements Library {
  readonly where: string;
  private readonly sql: postgres.Sql;

  constructor(
    private readonly connection: postgres.Sql,
    private readonly blobs: BlobStore,
    where = "Supabase",
  ) {
    this.sql = serialize(connection);
    this.where = where;
  }

  static fromEnv(env: NodeJS.ProcessEnv): SupabaseStore {
    const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
    if (!env.DATABASE_URL || !env.SUPABASE_URL || !key) {
      throw new Error("Supabase needs DATABASE_URL, SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY).");
    }
    // Accept the project URL with or without a path (people often paste the …/rest/v1/ endpoint).
    const projectUrl = new URL(env.SUPABASE_URL).origin;
    // prepare: false for Supabase's transaction pooler (port 6543), the only route in from IPv4-only hosts like Vercel.
    // One connection per instance so that serverless instances can't exhaust the pool; see serialize() for the queue.
    const sql = postgres(env.DATABASE_URL, {
      ssl: "require",
      prepare: false,
      max: 1,
      idle_timeout: 30,
      onnotice: () => {},
    });
    return new SupabaseStore(sql, supabaseBlobs(projectUrl, key), `Supabase (${new URL(projectUrl).host})`);
  }

  /** Fails fast at startup if the migration hasn't been applied. */
  async check(): Promise<void> {
    const [row] = await this.sql<{ ok: string | null }[]>`select to_regclass('producer.matters')::text as ok`;
    if (!row?.ok) throw new Error("The producer schema is missing. Apply supabase/migrations to your Supabase project.");
  }

  async close() {
    await this.connection.end();
  }

  /* ---------- reads ---------- */

  async home(): Promise<HomeData> {
    const [matters, decks, runs] = await Promise.all([
      this.sql<(MatterRow & { deck_count: number; run_count: number; last_run_at: Date | null; thumb_deck_id: string | null })[]>`
        select * from producer.matter_summaries order by updated_at desc`,
      this.sql<DeckSummaryRow[]>`select * from producer.deck_summaries order by updated_at desc`,
      this.sql<RunRow[]>`select * from producer.run_summaries order by started_at desc limit ${RECENT_RUNS}`,
    ]);
    return {
      matters: matters.map((m) => ({
        ...toMatter(m),
        deckCount: m.deck_count,
        runCount: m.run_count,
        lastRunAt: ms(m.last_run_at),
        thumbDeckId: m.thumb_deck_id,
      })),
      decks: decks.map(toDeckSummary),
      runs: runs.map(toRunSummary),
    };
  }

  async matter(id: string): Promise<MatterDetail | null> {
    if (!isId(id)) return null;
    const [[m], decks, runs] = await Promise.all([
      this.sql<MatterRow[]>`select * from producer.matters where id = ${id}`,
      this.sql<DeckSummaryRow[]>`select * from producer.deck_summaries where matter_id = ${id} order by updated_at desc`,
      this.sql<RunRow[]>`select * from producer.run_summaries where matter_id = ${id} order by started_at desc limit 200`,
    ]);
    if (!m) return null;
    return {
      matter: toMatter(m),
      decks: decks.map(toDeckSummary),
      runs: runs.map(toRunSummary),
    };
  }

  private async deckRecord(id: string, sql: postgres.Sql | postgres.TransactionSql = this.sql) {
    const [d] = await sql<(DeckRow & { matter_name: string; matter_solo: boolean })[]>`
      select d.*, m.name as matter_name, m.solo as matter_solo from producer.decks d join producer.matters m on m.id = d.matter_id where d.id = ${id}`;
    if (!d) return null;
    const regions = await sql<RegionRow[]>`
      select * from producer.regions where deck_id = ${id} order by slide_index, position`;
    return { row: d, record: { ...toDeckBase(d), slides: toSlides(d.slide_count, regions) } };
  }

  async deck(id: string): Promise<DeckDetail | null> {
    if (!isId(id)) return null;
    const d = await this.deckRecord(id);
    return d && { ...d.record, matterName: d.row.matter_name, matterSolo: d.row.matter_solo };
  }

  async run(id: string): Promise<RunDetail | null> {
    if (!isId(id)) return null;
    const [[r], events] = await Promise.all([
      this.sql<RunRow[]>`select * from producer.run_summaries where id = ${id}`,
      this.sql<EventRow[]>`select * from producer.run_events where run_id = ${id} order by seq`,
    ]);
    if (!r) return null;
    // Runs are deleted with their deck, so a run that exists always has its deck.
    return { ...toRunSummary(r), events: events.map(toEvent), deckExists: true };
  }

  async deckFile(deckId: string): Promise<DeckFileSource | null> {
    if (!isId(deckId)) return null;
    const [d] = await this.sql<{ pdf_path: string }[]>`select pdf_path from producer.decks where id = ${deckId}`;
    return d ? { url: await this.blobs.downloadUrl(d.pdf_path) } : null;
  }

  async thumb(deckId: string): Promise<Buffer | null> {
    if (!isId(deckId)) return null;
    const [d] = await this.sql<{ thumb_path: string | null }[]>`select thumb_path from producer.decks where id = ${deckId}`;
    return d?.thumb_path ? this.blobs.get(d.thumb_path) : null;
  }

  /* ---------- writes ---------- */

  async createMatter(name: string, deckMode: DeckMode, solo: boolean): Promise<Matter> {
    const [m] = await this.sql<MatterRow[]>`
      insert into producer.matters (name, deck_mode, solo) values (${name}, ${deckMode}, ${solo}) returning *`;
    return toMatter(m);
  }

  async renameMatter(id: string, name: string): Promise<Matter | null> {
    if (!isId(id)) return null;
    const [m] = await this.sql<MatterRow[]>`update producer.matters set name = ${name} where id = ${id} returning *`;
    return m ? toMatter(m) : null;
  }

  async deleteMatter(id: string): Promise<boolean> {
    if (!isId(id)) return false;
    const files = await this.sql<{ pdf_path: string; thumb_path: string | null }[]>`
      select pdf_path, thumb_path from producer.decks where matter_id = ${id}`;
    const deleted = await this.sql`delete from producer.matters where id = ${id}`;
    if (deleted.count === 0) return false;
    await this.blobs.remove(files.flatMap((f) => [f.pdf_path, f.thumb_path ?? []].flat()));
    return true;
  }

  async prepareUpload(matterId: string, format: DeckFormat): Promise<DeckUpload | null> {
    if (!isId(matterId)) return null;
    const [matter] = await this.sql<{ deck_mode: DeckMode; has_deck: boolean }[]>`
      select deck_mode, exists (select 1 from producer.decks d where d.matter_id = m.id) as has_deck
      from producer.matters m where id = ${matterId}`;
    if (!matter) return null;
    if (matter.deck_mode === "single" && matter.has_deck) throw new MatterFullError();
    const deckId = randomUUID();
    return { deckId, url: await this.blobs.uploadUrl(deckPathFor(deckId, format)) };
  }

  async createDeck(matterId: string, { deckId, name, format, pdfHash, slideCount }: DeckCreate): Promise<DeckRecord | null> {
    if (!isId(matterId)) return null;
    const [exists] = await this.sql`select 1 from producer.matters where id = ${matterId}`;
    if (!exists) return null;
    const pdfPath = deckPathFor(deckId, format);
    if (!isId(deckId) || !(await this.blobs.exists(pdfPath))) throw new UploadMissingError();
    try {
      const [d] = await this.sql<DeckRow[]>`
        insert into producer.decks (id, matter_id, name, pdf_hash, slide_count, pdf_path)
        values (${deckId}, ${matterId}, ${name}, ${pdfHash}, ${slideCount}, ${pdfPath})
        returning *`;
      return { ...toDeckBase(d), slides: toSlides(slideCount, []) };
    } catch (e) {
      await this.blobs.remove([pdfPath]);
      throw e;
    }
  }

  /** Throws if the project can't take a deck (or a demo) right now. */
  private async checkTarget(tx: postgres.TransactionSql, matterId: string, isDeck: boolean) {
    if (!isId(matterId)) throw new MatterNotFoundError();
    const [t] = await tx<{ deck_mode: string; decks: number }[]>`
      select m.deck_mode, (select count(*) from producer.decks d where d.matter_id = m.id)::int as decks
      from producer.matters m where m.id = ${matterId}`;
    if (!t) throw new MatterNotFoundError();
    if (isDeck && t.deck_mode === "single" && t.decks > 0) throw new MatterFullError();
  }

  /** A hidden solo matter that no longer holds anything goes away with its last item. */
  private async dropIfEmptySolo(tx: postgres.TransactionSql, matterId: string) {
    await tx`
      delete from producer.matters m where m.id = ${matterId} and m.solo
        and not exists (select 1 from producer.decks d where d.matter_id = m.id)
        and not exists (select 1 from producer.shows s where s.matter_id = m.id)`;
  }

  async patchDeck(id: string, patch: DeckPatch): Promise<DeckRecord | null> {
    if (!isId(id)) return null;
    return this.sql.begin(async (tx) => {
      const [before] = await tx<{ matter_id: string }[]>`select matter_id from producer.decks where id = ${id}`;
      if (!before) return null;
      const moving = patch.matterId !== undefined && patch.matterId !== before.matter_id;
      if (moving) await this.checkTarget(tx, patch.matterId!, true);
      const [d] = await tx<DeckRow[]>`
        update producer.decks set
          matter_id = ${moving ? patch.matterId! : before.matter_id}::uuid,
          name = coalesce(${patch.name ?? null}, name),
          analyzed = coalesce(${patch.analyzed ?? null}, analyzed),
          plan = coalesce(${patch.plan ? tx.json(patch.plan) : null}::jsonb, plan)
        where id = ${id} returning *`;
      if (!d) return null;
      if (moving) await this.dropIfEmptySolo(tx, before.matter_id);
      if (patch.slides) {
        // Replace the deck's regions wholesale; small (tens of rows) and keeps ordering exact.
        await tx`delete from producer.regions where deck_id = ${id}`;
        const rows = regionRows(patch.slides, d.slide_count);
        if (rows.length) {
          await tx`
            insert into producer.regions
              (deck_id, slide_index, position, region_key, label, description, keywords, cue, phrases, marks, box_x, box_y, box_w, box_h)
            select ${id}, x.slide_index, x.position, x.region_key, x.label, x.description, x.keywords, x.cue, x.phrases, x.marks,
                   x.box_x, x.box_y, x.box_w, x.box_h
            from jsonb_to_recordset(${tx.json(rows)}::jsonb) as x(
              slide_index int, position int, region_key text, label text, description text, keywords text[],
              cue text, phrases text[], marks jsonb, box_x float8, box_y float8, box_w float8, box_h float8)`;
        }
      }
      return (await this.deckRecord(id, tx))!.record;
    });
  }

  async setThumb(id: string, jpeg: Buffer): Promise<boolean> {
    if (!isId(id)) return false;
    const [exists] = await this.sql`select 1 from producer.decks where id = ${id}`;
    if (!exists) return false;
    const path = `${id}/thumb.jpg`;
    await this.blobs.put(path, jpeg, "image/jpeg");
    await this.sql`update producer.decks set thumb_path = ${path} where id = ${id}`;
    return true;
  }

  async deleteDeck(id: string): Promise<boolean> {
    if (!isId(id)) return false;
    const [d] = await this.sql<{ pdf_path: string; thumb_path: string | null }[]>`
      delete from producer.decks where id = ${id} returning pdf_path, thumb_path`;
    if (!d) return false;
    await this.blobs.remove([d.pdf_path, ...(d.thumb_path ? [d.thumb_path] : [])]);
    return true;
  }

  async addRun(input: RunInput): Promise<Run | null> {
    if (!isId(input.deckId)) return null;
    const stats = summarizeRun(input);
    return this.sql.begin(async (tx) => {
      const [d] = await tx<{ name: string; slide_count: number; matter_id: string }[]>`
        select name, slide_count, matter_id from producer.decks where id = ${input.deckId}`;
      if (!d) return null;
      const [r] = await tx<{ id: string }[]>`
        insert into producer.runs
          (deck_id, deck_name, slide_count, engine, started_at, ended_at, slides_visited, zooms, commands, words)
        values (${input.deckId}, ${d.name}, ${d.slide_count}, ${input.engine},
                ${new Date(input.startedAt)}, ${new Date(Math.max(input.endedAt, input.startedAt))},
                ${stats.slidesVisited}, ${stats.zooms}, ${stats.commands}, ${stats.words})
        returning id`;
      const events = input.events.map((e, seq) => ({
        seq,
        t_ms: Math.max(0, Math.round(e.t)),
        type: e.type,
        slide_index: Math.max(0, e.slide),
        region_key: e.type === "zoom" ? e.regionId : null,
        label: e.type === "zoom" ? e.label : null,
        cue: e.type === "zoom" ? (e.cue ?? null) : null,
        command: e.type === "command" ? e.command : null,
        text: e.type === "command" || e.type === "heard" ? e.text : null,
        simulated: e.type === "heard" && !!e.simulated,
      }));
      if (events.length) {
        await tx`
          insert into producer.run_events (run_id, seq, t_ms, type, slide_index, region_key, label, cue, command, text, simulated)
          select ${r.id}, x.seq, x.t_ms, x.type, x.slide_index, x.region_key, x.label, x.cue, x.command, x.text, x.simulated
          from jsonb_to_recordset(${tx.json(events)}::jsonb) as x(
            seq int, t_ms int, type text, slide_index int, region_key text, label text, cue text, command text, text text,
            simulated boolean)`;
      }
      return {
        ...input,
        id: r.id,
        matterId: d.matter_id,
        deckName: d.name,
        slideCount: d.slide_count,
        stats,
      };
    });
  }

  async recordUsage(e: UsageEntry): Promise<void> {
    await this.sql`
      insert into producer.analysis_usage
        (deck_id, kind, slide_index, model, effort, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms)
      values (${e.deckId}, ${e.kind}, ${e.slideIndex}, ${e.model}, ${e.effort}, ${e.inputTokens}, ${e.outputTokens},
              ${e.cacheReadTokens}, ${e.cacheWriteTokens}, ${e.costUsd}, ${e.durationMs})`;
  }

  async deckUsage(deckId: string): Promise<UsageSummary> {
    const empty: UsageSummary = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
    if (!isId(deckId)) return empty;
    const [u] = await this.sql<{ calls: number; input: number; output: number; read: number; write: number; cost: number }[]>`
      select count(*)::int as calls, coalesce(sum(input_tokens), 0)::int as input, coalesce(sum(output_tokens), 0)::int as output,
             coalesce(sum(cache_read_tokens), 0)::int as read, coalesce(sum(cache_write_tokens), 0)::int as write,
             coalesce(sum(cost_usd), 0)::float8 as cost
      from producer.analysis_usage where deck_id = ${deckId}`;
    return { calls: u.calls, inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.read, cacheWriteTokens: u.write, costUsd: u.cost };
  }

  async deleteRun(id: string): Promise<boolean> {
    if (!isId(id)) return false;
    const r = await this.sql`delete from producer.runs where id = ${id}`;
    return r.count > 0;
  }

  async expireRuns(before: number): Promise<number> {
    // run_events go with their run (on delete cascade).
    const r = await this.sql`delete from producer.runs where started_at < ${new Date(before)}`;
    return r.count;
  }

  /* ---------- shows ---------- */

  async shows(matterId: string): Promise<Show[] | null> {
    if (!isId(matterId)) return null;
    const [m] = await this.sql<MatterRow[]>`select * from producer.matters where id = ${matterId}`;
    if (!m) return null;
    const rows = await this.sql<ShowRow[]>`select * from producer.shows where matter_id = ${matterId} order by updated_at desc`;
    return rows.map(toShow);
  }

  async allShows(): Promise<Show[]> {
    return (await this.sql<ShowRow[]>`select * from producer.shows order by updated_at desc`).map(toShow);
  }

  async show(id: string): Promise<Show | null> {
    if (!isId(id)) return null;
    const [r] = await this.sql<ShowRow[]>`select * from producer.shows where id = ${id}`;
    return r ? toShow(r) : null;
  }

  async createShow(matterId: string, name: string): Promise<Show | null> {
    if (!isId(matterId)) return null;
    const [r] = await this.sql<ShowRow[]>`
      insert into producer.shows (matter_id, name)
      select id, ${name} from producer.matters where id = ${matterId} returning *`;
    return r ? toShow(r) : null;
  }

  async patchShow(id: string, patch: ShowPatch): Promise<Show | null> {
    if (!isId(id)) return null;
    const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
    return this.sql.begin(async (tx) => {
      const [before] = await tx<{ matter_id: string }[]>`select matter_id from producer.shows where id = ${id}`;
      if (!before) return null;
      const moving = patch.matterId !== undefined && patch.matterId !== before.matter_id;
      if (moving) await this.checkTarget(tx, patch.matterId!, false);
      const [r] = await tx<ShowRow[]>`
        update producer.shows set
          matter_id = ${moving ? patch.matterId! : before.matter_id}::uuid,
          name = coalesce(${patch.name ?? null}, name),
          beats = coalesce(${json(patch.beats)}::jsonb, beats),
          limits = coalesce(${json(patch.limits)}::jsonb, limits),
          recording_id = coalesce(${patch.recordingId ?? null}, recording_id),
          cover = coalesce(${patch.cover ?? null}, cover),
          dry_runs = coalesce(${json(patch.dryRuns)}::jsonb, dry_runs)
        where id = ${id} returning *`;
      if (!r) return null;
      if (moving) await this.dropIfEmptySolo(tx, before.matter_id);
      return toShow(r);
    });
  }

  async deleteShow(id: string): Promise<boolean> {
    if (!isId(id)) return false;
    const deleted = await this.sql`delete from producer.shows where id = ${id}`;
    return deleted.count > 0;
  }
}

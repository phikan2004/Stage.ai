import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DeckSummary, HomeData, MatterSummary, Show } from "../../../shared/schema";
import { api } from "../lib/api";
import { addDeck, createSampleMatter, pickFiles } from "../lib/deck";
import { deckTitle, plural, relTime } from "../lib/format";
import { back as goBack, go } from "../lib/router";
import { coverUrl } from "../lib/stage";
import { ConfirmDialog, Loading, NameDialog, Select, TopBar, type Tab } from "./Chrome";

/** The library tabs; Home is its own page. */
type ListTab = Exclude<Tab, "home">;

const INTRO: Record<ListTab, { title: ReactNode; line: string }> = {
  projects: {
    title: (
      <>
        Every pitch, <em>in one place</em>
      </>
    ),
    line: "A project gathers the decks and demos for one client, meeting or event.",
  },
  decks: {
    title: (
      <>
        Slides that <em>follow</em> your voice
      </>
    ),
    line: "Stage listens while you present and zooms into whatever you're talking about.",
  },
  demos: {
    title: (
      <>
        Demos that <em>run themselves</em>
      </>
    ),
    line: "Do a demo once while explaining it. Stage learns it and performs it live while you talk.",
  },
};

const SORTS = { recent: "Recent", az: "A–Z", za: "Z–A" } as const;
type Sort = keyof typeof SORTS;

/** Matters are shown as projects; a solo matter is the hidden home of one deck or demo. */
const NO_PROJECT = "";

export const tabPath = (tab: Tab) => (tab === "projects" ? "/projects" : tab === "demos" ? "/demos" : tab === "decks" ? "/decks" : "/");
const projectPath = (id: string) => `/m/${id}`;

const canTakeDeck = (m: MatterSummary) => m.deckMode !== "single" || m.deckCount === 0;

type Entry =
  | { kind: "project"; project: MatterSummary; name: string; updatedAt: number }
  | { kind: "deck"; deck: DeckSummary; name: string; updatedAt: number; projectName: string | null }
  | { kind: "demo"; show: Show; name: string; updatedAt: number; projectName: string | null };

function sortEntries(entries: Entry[], sort: Sort): Entry[] {
  const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const byRecent = (a: Entry, b: Entry) => b.updatedAt - a.updatedAt;
  const order = { recent: byRecent, az: byName, za: (a: Entry, b: Entry) => byName(b, a) }[sort];
  return [...entries].sort(order);
}

/** Projects, decks or demos; or one project with everything in it. */
export default function LibraryView({ tab, projectId }: { tab: Tab; projectId?: string }) {
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Separate from the rest, so demos being unavailable can't take the page down.
  const [shows, setShows] = useState<Show[] | null>(null);

  const load = useCallback(() => {
    api
      .home()
      .then(setData)
      .catch((e) => setError(`The Stage server isn't reachable (${e instanceof Error ? e.message : e}). Start it with npm run dev.`));
    api.allShows().then(setShows).catch(() => setShows(null));
  }, []);
  useEffect(load, [load]);

  const projects = data?.matters.filter((m) => !m.solo) ?? [];
  const project = projects.find((m) => m.id === projectId);
  // Decks and demos that live alone (in a hidden matter of their own) can join an open project.
  const soloIds = new Set(data?.matters.filter((m) => m.solo).map((m) => m.id) ?? []);
  const looseDecks = data?.decks.filter((d) => soloIds.has(d.matterId)) ?? [];
  const looseDemos = (shows ?? []).filter((s) => soloIds.has(s.matterId));

  return (
    <>
      <TopBar tab={tab}>
        {data && (
          <NewMenu
            projects={projects}
            current={project}
            loose={{ decks: looseDecks, demos: looseDemos }}
            reload={load}
          />
        )}
      </TopBar>
      <main className="page">
        {error && <div className="banner err">{error}</div>}
        {!data && !error && <Loading />}
        {data &&
          (projectId ? (
            project ? (
              <ProjectPage project={project} data={data} shows={shows} reload={load} />
            ) : (
              <div className="banner err">That project no longer exists.</div>
            )
          ) : tab === "home" ? (
            <HomePage data={data} shows={shows} reload={load} onError={setError} />
          ) : (
            <Overview tab={tab} data={data} shows={shows} reload={load} onError={setError} />
          ))}
      </main>
    </>
  );
}

function Overview({
  tab,
  data,
  shows,
  reload,
  onError,
}: {
  tab: ListTab;
  data: HomeData;
  shows: Show[] | null;
  reload: () => void;
  onError: (message: string) => void;
}) {
  const [sort, setSort] = useState<Sort>("recent");
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const hit = (name: string) => name.toLowerCase().includes(q);
  const projectName = (matterId: string) => {
    const m = data.matters.find((x) => x.id === matterId);
    return m && !m.solo ? m.name : null;
  };

  const entries: Entry[] =
    tab === "projects"
      ? data.matters.filter((m) => !m.solo).map((m): Entry => ({ kind: "project", project: m, name: m.name, updatedAt: m.updatedAt }))
      : tab === "decks"
        ? data.decks.map((d): Entry => ({ kind: "deck", deck: d, name: deckTitle(d.name), updatedAt: d.updatedAt, projectName: projectName(d.matterId) }))
        : (shows ?? []).map((s): Entry => ({ kind: "demo", show: s, name: s.name, updatedAt: s.updatedAt, projectName: projectName(s.matterId) }));
  // A project also matches when something inside it does, and an item when its project does.
  const inside = (projectId: string) =>
    data.decks.some((d) => d.matterId === projectId && hit(deckTitle(d.name))) || (shows ?? []).some((s) => s.matterId === projectId && hit(s.name));
  const matches = (e: Entry) => !q || hit(e.name) || (e.kind === "project" ? inside(e.project.id) : !!e.projectName && hit(e.projectName));
  const shown = sortEntries(entries.filter(matches), sort);

  const actions = useItemActions(reload);

  const intro = INTRO[tab];
  const what = tab === "projects" ? "projects" : tab === "decks" ? "decks" : "demos";
  const kind: NewKind = tab === "projects" ? "project" : tab === "decks" ? "deck" : "demo";
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="display">{intro.title}</h1>
          <p className="intro-line">{intro.line}</p>
        </div>
      </div>

      <div className="library-tools">
        <SortMenu value={sort} onChange={setSort} />
        <input
          className="field library-search"
          type="search"
          placeholder={`Search ${what}`}
          aria-label="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {tab === "demos" && !shows ? (
        <div className="empty-row">Demos aren't available here yet.</div>
      ) : shown.length ? (
        <div className="cards library">
          {!q && <StartCard kind={kind} hint={`Add another ${kind}.`} />}
          {shown.map((e) =>
            e.kind === "project" ? (
              <ProjectCard
                key={e.project.id}
                project={e.project}
                demos={(shows ?? []).filter((s) => s.matterId === e.project.id)}
                menu={actions.menu({ kind: "project", project: e.project, demoCount: shows ? shows.filter((s) => s.matterId === e.project.id).length : null })}
              />
            ) : e.kind === "deck" ? (
              <DeckCard key={e.deck.id} deck={e.deck} projectName={e.projectName} menu={actions.menu({ kind: "deck", deck: e.deck, solo: !e.projectName })} />
            ) : (
              <DemoCard key={e.show.id} show={e.show} projectName={e.projectName} menu={actions.menu({ kind: "demo", show: e.show, solo: !e.projectName })} />
            ),
          )}
        </div>
      ) : q ? (
        <div className="empty-row">Nothing matches “{query.trim()}”.</div>
      ) : (
        <div className="cards library">
          <StartCard kind={kind} hint={`You don't have any ${what} yet.`} />
        </div>
      )}

      {tab === "decks" && data.matters.length === 0 && <SampleLine onError={onError} />}
      {actions.dialogs}
    </>
  );
}

const RECENT_ON_HOME = 6;
const PROJECTS_ON_HOME = 3;

function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

const QUICK_STARTS: { kind: NewKind; title: string; line: string; glyph: string }[] = [
  { kind: "deck", title: "New deck", line: "Upload PowerPoint or PDF and Stage finds what to zoom into.", glyph: "▭" },
  { kind: "demo", title: "New demo", line: "Do it once while talking. Stage learns it and performs it live.", glyph: "▶" },
  { kind: "project", title: "New project", line: "Gather the decks and demos for one client or meeting.", glyph: "◫" },
];

/** Where you land: start something, or pick up what you touched last. */
function HomePage({ data, shows, reload, onError }: { data: HomeData; shows: Show[] | null; reload: () => void; onError: (message: string) => void }) {
  const actions = useItemActions(reload);
  const projectName = (matterId: string) => {
    const m = data.matters.find((x) => x.id === matterId);
    return m && !m.solo ? m.name : null;
  };
  const recent: Entry[] = sortEntries(
    [
      ...data.decks.map((d): Entry => ({ kind: "deck", deck: d, name: deckTitle(d.name), updatedAt: d.updatedAt, projectName: projectName(d.matterId) })),
      ...(shows ?? []).map((s): Entry => ({ kind: "demo", show: s, name: s.name, updatedAt: s.updatedAt, projectName: projectName(s.matterId) })),
    ],
    "recent",
  ).slice(0, RECENT_ON_HOME);
  const projects = data.matters.filter((m) => !m.solo).sort((a, b) => b.updatedAt - a.updatedAt);
  const empty = !recent.length && !projects.length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="display">
            {greeting()}. <em className="nowrap">What's next?</em>
          </h1>
          <p className="intro-line">Pick up where you left off, or start something new for your next meeting.</p>
        </div>
      </div>

      <div className="home-starts">
        {QUICK_STARTS.map((q) => (
          <button key={q.kind} className="home-start" onClick={() => startNew(q.kind)}>
            <span className="home-start-glyph" aria-hidden="true">
              {q.glyph}
            </span>
            <span className="card-title">{q.title}</span>
            <span className="hint">{q.line}</span>
          </button>
        ))}
      </div>
      {empty && <SampleLine onError={onError} />}

      {recent.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="display">Recents</h2>
            <div className="spacer" />
            <a className="section-link" href="#/decks">
              All decks
            </a>
            <a className="section-link" href="#/demos">
              All demos
            </a>
          </div>
          <div className="cards library">
            {recent.map((e) =>
              e.kind === "deck" ? (
                <DeckCard key={e.deck.id} deck={e.deck} projectName={e.projectName} menu={actions.menu({ kind: "deck", deck: e.deck, solo: !e.projectName })} />
              ) : e.kind === "demo" ? (
                <DemoCard key={e.show.id} show={e.show} projectName={e.projectName} menu={actions.menu({ kind: "demo", show: e.show, solo: !e.projectName })} />
              ) : null,
            )}
          </div>
        </section>
      )}

      {projects.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="display">Projects</h2>
            <div className="spacer" />
            <a className="section-link" href="#/projects">
              All {plural(projects.length, "project")}
            </a>
          </div>
          <div className="cards library">
            {projects.slice(0, PROJECTS_ON_HOME).map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                demos={(shows ?? []).filter((s) => s.matterId === p.id)}
                menu={actions.menu({ kind: "project", project: p, demoCount: shows ? shows.filter((s) => s.matterId === p.id).length : null })}
              />
            ))}
          </div>
        </section>
      )}
      {actions.dialogs}
    </>
  );
}

function ProjectPage({ project, data, shows, reload }: { project: MatterSummary; data: HomeData; shows: Show[] | null; reload: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const decks = data.decks.filter((d) => d.matterId === project.id);
  const demos = (shows ?? []).filter((s) => s.matterId === project.id);
  const counts = [plural(decks.length, "deck"), ...(shows ? [plural(demos.length, "demo")] : [])].join(" · ");
  const deleteProject = async () => {
    if (!confirm(`Delete “${project.name}” with its ${counts.replace(" · ", " and ")}? This can't be undone.`)) return;
    await api.deleteMatter(project.id);
    go(tabPath("projects"));
  };

  const actions = useItemActions(reload);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="micro">Project · {counts}</div>
          <h1 className="display">{project.name}</h1>
        </div>
        <div className="page-actions">
          <button className="btn small ghost" onClick={() => goBack("/projects")}>
            ← Back
          </button>
          <button className="btn small ghost" onClick={() => setRenaming(true)}>
            Rename
          </button>
          <button className="btn small ghost danger" onClick={deleteProject}>
            Delete project
          </button>
        </div>
      </div>

      <section className="section first">
        <div className="section-head">
          <h2 className="display">Decks</h2>
        </div>
        {decks.length ? (
          <div className="cards library">
            {decks.map((d) => (
              <DeckCard key={d.id} deck={d} projectName={null} showOpen menu={actions.menu({ kind: "deck", deck: d, solo: false })} />
            ))}
          </div>
        ) : (
          <div className="cards library">
            <StartCard kind="deck" hint="This project has no decks yet." />
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="display">Demos</h2>
        </div>
        {!shows ? (
          <div className="empty-row">Demos aren't available here yet.</div>
        ) : demos.length ? (
          <div className="cards library">
            {demos.map((s) => (
              <DemoCard key={s.id} show={s} projectName={null} showOpen menu={actions.menu({ kind: "demo", show: s, solo: false })} />
            ))}
          </div>
        ) : (
          <div className="cards library">
            <StartCard kind="demo" hint="This project has no demos yet." />
          </div>
        )}
      </section>

      {renaming && (
        <NameDialog
          title="Rename project"
          label="Name"
          initial={project.name}
          submitLabel="Save"
          onClose={() => setRenaming(false)}
          onSubmit={async (n) => {
            await api.renameMatter(project.id, n);
            setRenaming(false);
            reload();
          }}
        />
      )}
      {actions.dialogs}
    </>
  );
}

/** The New deck / New demo switch, shown when a project is open and something loose can join it. */
function ModeSwitch({ kind, existing, onChange }: { kind: "deck" | "demo"; existing: boolean; onChange: (existing: boolean) => void }) {
  return (
    <div className="seg" role="group" aria-label="Where it comes from">
      <button type="button" aria-pressed={!existing} onClick={() => onChange(false)}>
        New {kind}
      </button>
      <button type="button" aria-pressed={existing} onClick={() => onChange(true)}>
        Existing {kind}
      </button>
    </div>
  );
}

/** Pick decks or demos that aren't in any project yet, and move them into the open project. */
function ExistingDialog({
  kind,
  project,
  items,
  onSwitch,
  onClose,
  reload,
}: {
  kind: "deck" | "demo";
  project: MatterSummary;
  items: { id: string; name: string }[];
  onSwitch: () => void;
  onClose: () => void;
  reload: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A project that holds one deck takes at most one more here.
  const oneOnly = kind === "deck" && project.deckMode === "single";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const toggle = (id: string) =>
    setPicked((p) => {
      if (p.includes(id)) return p.filter((k) => k !== id);
      if (oneOnly) return [id];
      return [...p, id];
    });

  const add = async () => {
    setBusy(true);
    setError(null);
    let moved = 0;
    try {
      for (const id of picked) {
        if (kind === "deck") await api.patchDeck(id, { matterId: project.id });
        else await api.patchShow(id, { matterId: project.id });
        moved++;
      }
      onClose();
    } catch (e) {
      setError(`${moved ? `${plural(moved, "item")} added, then: ` : ""}${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
    // Refresh either way: some items may have moved before a failure.
    reload();
  };

  return (
    <div className="overlay" onMouseDown={(e) => !busy && e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <h3 className="display">Add an existing {kind}</h3>
        <ModeSwitch kind={kind} existing onChange={(existing) => !existing && onSwitch()} />
        {items.length === 0 ? (
          <p className="dialog-text">Nothing outside a project to add.</p>
        ) : (
          <div className="pick-list">
            {items.map((it) => {
              const on = picked.includes(it.id);
              return (
                <button key={it.id} type="button" className={`pick-row ${on ? "on" : ""}`} aria-pressed={on} onClick={() => toggle(it.id)} disabled={busy}>
                  <span className="pick-box" aria-hidden="true">
                    {on ? "✓" : ""}
                  </span>
                  <span className="pick-name">{it.name}</span>
                </button>
              );
            })}
          </div>
        )}
        {error && <div className="banner err">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {items.length > 0 && (
            <button type="button" className="btn primary" onClick={add} disabled={!picked.length || busy}>
              {busy ? "Adding…" : picked.length ? `Add ${plural(picked.length, "item")}` : "Add"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Shown where nothing exists yet; opens the same flow as New, into the open project if there is one. */
function StartCard({ kind, hint }: { kind: NewKind; hint: string }) {
  return (
    <button className={`card ${kind === "project" ? "project-card " : ""}card-start`} onClick={() => startNew(kind)}>
      <div className="card-img">
        <span className="plus">+</span>
      </div>
      <div className="card-body">
        <div className="card-title">New {kind}</div>
        <div className="hint">{hint}</div>
      </div>
    </button>
  );
}

function ProjectCard({ project: p, demos, menu }: { project: MatterSummary; demos: Show[]; menu: ReactNode }) {
  // Its newest deck's first slide, else its newest demo's screenshot.
  const cover = p.thumbDeckId ? undefined : demos.find((s) => coverUrl(s));
  return (
    <CardShell menu={menu}>
      <a className="card project-card" href={`#${projectPath(p.id)}`}>
        <div className="card-img">
          {p.thumbDeckId && <img src={api.thumbUrl(p.thumbDeckId, p.updatedAt)} alt="" />}
          {cover && <Cover show={cover} />}
          {!p.thumbDeckId && !cover && <Monogram name={p.name} />}
          <span className="badge quiet">Project</span>
        </div>
        <div className="card-body">
          <div className="card-title">{p.name}</div>
          <div className="hint">
            {plural(p.deckCount, "deck")} · {plural(demos.length, "demo")} · {relTime(p.updatedAt)}
          </div>
        </div>
      </a>
    </CardShell>
  );
}

function DeckCard({ deck: d, projectName, showOpen = false, menu }: { deck: DeckSummary; projectName: string | null; showOpen?: boolean; menu: ReactNode }) {
  return (
    <CardShell menu={menu}>
      <a className="card" href={`#/d/${d.id}`}>
        <div className="card-img">
          {d.hasThumb && <img src={api.thumbUrl(d.id)} alt="" />}
          {!d.analyzed && <span className="badge">Needs analysis</span>}
        </div>
        <div className="card-body">
          <div className="card-title">{deckTitle(d.name)}</div>
          <div className="hint">
            {projectName && `${projectName} · `}
            {plural(d.slideCount, "slide")} · {plural(d.regionCount, "region")} · {relTime(d.updatedAt)}
          </div>
          {showOpen && <span className="btn small primary card-open">Open</span>}
        </div>
      </a>
    </CardShell>
  );
}

/** A demo's cover screenshot; its initial when the runner can't serve one, so the card never looks empty. */
function Cover({ show }: { show: Show }) {
  const [failed, setFailed] = useState(false);
  const url = coverUrl(show);
  return url && !failed ? <img src={url} alt="" onError={() => setFailed(true)} /> : <Monogram name={show.name} />;
}

/** A name's first letter, standing in for a picture. */
function Monogram({ name }: { name: string }) {
  return (
    <span className="monogram" aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || "·"}
    </span>
  );
}

/** One dot per cue: green if the last dry run got through it, amber if not, hollow if never tried. */
function BeatDots({ show: s }: { show: Show }) {
  const last = s.dryRuns.at(-1);
  return (
    <span className="beat-dots" aria-hidden="true">
      {s.beats.map((b) => {
        const r = last?.results.find((x) => x.beatId === b.id);
        return <i key={b.id} className={!r || r.outcome === "stopped" ? "" : r.outcome === "done" ? "done" : "miss"} />;
      })}
    </span>
  );
}

function DemoCard({ show: s, projectName, showOpen = false, menu }: { show: Show; projectName: string | null; showOpen?: boolean; menu: ReactNode }) {
  return (
    <CardShell menu={menu}>
      <a className="card" href={`#/s/${s.id}`}>
        <div className="card-img">
          <Cover show={s} />
          <BeatDots show={s} />
        </div>
        <div className="card-body">
          <div className="card-title">{s.name}</div>
          <div className="hint">
            {projectName && `${projectName} · `}
            {s.beats.length ? plural(s.beats.length, "cue") : "Not taught yet"}
            {s.dryRuns.length > 0 && ` · ${plural(s.dryRuns.length, "dry run")}`} · {relTime(s.updatedAt)}
          </div>
          {showOpen && <span className="btn small primary card-open">Open</span>}
        </div>
      </a>
    </CardShell>
  );
}

/** Keeps a card's ⋯ menu beside its link rather than inside it, so using the menu never opens the card. */
function CardShell({ menu, children }: { menu: ReactNode; children: ReactNode }) {
  return (
    <div className="card-shell">
      {children}
      {menu}
    </div>
  );
}

/** Something in the library that can be renamed or deleted without opening it. */
type Item =
  | { kind: "project"; project: MatterSummary; demoCount: number | null }
  | { kind: "deck"; deck: DeckSummary; solo: boolean }
  | { kind: "demo"; show: Show; solo: boolean };

const KIND_NAME: Record<Item["kind"], string> = { project: "project", deck: "deck", demo: "demo" };
const itemName = (i: Item) => (i.kind === "project" ? i.project.name : i.kind === "deck" ? deckTitle(i.deck.name) : i.show.name);

async function renameItem(i: Item, name: string) {
  if (i.kind === "project") await api.renameMatter(i.project.id, name);
  // Keep the file's extension, which the library hides.
  else if (i.kind === "deck") await api.patchDeck(i.deck.id, { name: name + (i.deck.name.match(/\.(pdf|pptx)$/i)?.[0] ?? "") });
  else await api.patchShow(i.show.id, { name });
}

// Something not in a project lives in a hidden matter of its own, which goes with it.
async function deleteItem(i: Item) {
  if (i.kind === "project") await api.deleteMatter(i.project.id);
  else if (i.kind === "deck") await (i.solo ? api.deleteMatter(i.deck.matterId) : api.deleteDeck(i.deck.id));
  else await (i.solo ? api.deleteMatter(i.show.matterId) : api.deleteShow(i.show.id));
}

function deleteNote(i: Item): string {
  if (i.kind === "project") {
    const inside = [
      i.project.deckCount && plural(i.project.deckCount, "deck"),
      i.demoCount && plural(i.demoCount, "demo"),
    ].filter(Boolean);
    return `${inside.length ? `Its ${inside.join(" and ")} go with it. ` : ""}This can't be undone.`;
  }
  if (i.kind === "deck") return `${i.deck.runCount ? `Its ${plural(i.deck.runCount, "run")} go with it. ` : ""}This can't be undone.`;
  return "This can't be undone. Its recording stays on this Mac.";
}

/** A ⋯ menu for any item, with the rename and delete dialogs it opens. */
function useItemActions(reload: () => void) {
  const [renaming, setRenaming] = useState<Item | null>(null);
  const [deleting, setDeleting] = useState<Item | null>(null);
  const menu = (item: Item) => (
    <Menu boxClassName="card-more-box" className="card-more" label="⋯" title={`Rename or delete “${itemName(item)}”`}>
      {(close) => (
        <>
          <button role="menuitem" onClick={() => (close(), setRenaming(item))}>
            Rename
          </button>
          <button role="menuitem" className="danger" onClick={() => (close(), setDeleting(item))}>
            Delete
          </button>
        </>
      )}
    </Menu>
  );
  const dialogs = (
    <>
      {renaming && (
        <NameDialog
          title={`Rename ${KIND_NAME[renaming.kind]}`}
          label="Name"
          initial={itemName(renaming)}
          submitLabel="Save"
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            await renameItem(renaming, name);
            setRenaming(null);
            reload();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete “${itemName(deleting)}”?`}
          confirmLabel={`Delete ${KIND_NAME[deleting.kind]}`}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await deleteItem(deleting);
            setDeleting(null);
            reload();
          }}
        >
          {deleteNote(deleting)}
        </ConfirmDialog>
      )}
    </>
  );
  return { menu, dialogs };
}

/** A small menu under a button; closes on a pick, a click elsewhere or Escape. */
function Menu({
  label,
  className,
  boxClassName,
  title,
  children,
}: {
  label: ReactNode;
  className: string;
  boxClassName?: string;
  /** Names a button whose label is only a symbol. */
  title?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className={`menu-box ${boxClassName ?? ""}`} ref={box}>
      <button className={className} title={title} aria-label={title} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && (
        <div className="menu" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function SortMenu({ value, onChange }: { value: Sort; onChange: (s: Sort) => void }) {
  return (
    <Menu className="btn small ghost" label={`Sort: ${SORTS[value]} ▾`}>
      {(close) =>
        (Object.keys(SORTS) as Sort[]).map((s) => (
          <button
            key={s}
            role="menuitemradio"
            aria-checked={s === value}
            onClick={() => {
              onChange(s);
              close();
            }}
          >
            {SORTS[s]}
          </button>
        ))
      }
    </Menu>
  );
}

/** The one way to add anything: a project, a deck or a demo. */
function NewMenu({ projects, current, loose, reload }: { projects: MatterSummary[]; current?: MatterSummary; loose: { decks: DeckSummary[]; demos: Show[] }; reload: () => void }) {
  const [making, setMaking] = useState<NewKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = (kind: NewKind) => {
    setError(null);
    setMaking(kind);
  };
  useEffect(() => {
    const on = (e: Event) => pick((e as CustomEvent<NewKind>).detail);
    window.addEventListener(NEW_EVENT, on);
    return () => window.removeEventListener(NEW_EVENT, on);
  });

  return (
    <>
      <Menu className="btn small primary" label="New">
        {(close) =>
          (["project", "deck", "demo"] as const).map((k) => (
            <button
              key={k}
              role="menuitem"
              onClick={() => {
                close();
                pick(k);
              }}
            >
              {k === "project" ? "Project" : k === "deck" ? "Deck" : "Demo"}
            </button>
          ))
        }
      </Menu>
      {/* The top bar's blur would trap fixed dialogs inside it, so they render on the page itself. */}
      {createPortal(
        <>
          {making === "project" && (
            <NameDialog
              title="New project"
              label="Name"
              submitLabel="Create project"
              onClose={() => setMaking(null)}
              onSubmit={async (name) => {
                const m = await api.createMatter(name);
                setMaking(null);
                go(projectPath(m.id));
              }}
            />
          )}
          {making === "demo" && <NewDemoDialog projects={projects} current={current} loose={loose.demos} reload={reload} onClose={() => setMaking(null)} />}
          {making === "deck" && (
            <NewDeckDialog projects={projects.filter(canTakeDeck)} current={current} loose={loose.decks} reload={reload} onClose={() => setMaking(null)} onError={setError} />
          )}
          {error && (
            <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setError(null)}>
              <div className="dialog">
                <div className="banner err">{error}</div>
                <div className="dialog-actions">
                  <button className="btn primary" onClick={() => setError(null)}>
                    OK
                  </button>
                </div>
              </div>
            </div>
          )}
        </>,
        document.body,
      )}
    </>
  );
}

function ProjectSelect({ projects, value, onChange }: { projects: MatterSummary[]; value: string; onChange: (id: string) => void }) {
  return (
    <Select
      label="Project"
      value={value}
      onChange={onChange}
      options={[{ value: NO_PROJECT, label: "No project" }, ...projects.map((m) => ({ value: m.id, label: m.name }))]}
    />
  );
}

type NewKind = "project" | "deck" | "demo";
const NEW_EVENT = "stage:new";
/** Opens the New menu's flow for one kind, from anywhere on the page. */
const startNew = (kind: NewKind) => window.dispatchEvent(new CustomEvent<NewKind>(NEW_EVENT, { detail: kind }));

/** Where something new goes: the chosen project, or a hidden matter of its own. */
const homeFor = async (projectId: string, name: string) => (projectId === NO_PROJECT ? (await api.createMatter(name, true)).id : projectId);

function NewDemoDialog({
  projects,
  current,
  loose,
  reload,
  onClose,
}: {
  projects: MatterSummary[];
  current?: MatterSummary;
  loose: Show[];
  reload: () => void;
  onClose: () => void;
}) {
  const [target, setTarget] = useState(current?.id ?? NO_PROJECT);
  const [existing, setExisting] = useState(false);
  const offer = !!current && loose.length > 0;
  if (existing && current)
    return (
      <ExistingDialog
        kind="demo"
        project={current}
        items={loose.map((s) => ({ id: s.id, name: s.name }))}
        onSwitch={() => setExisting(false)}
        onClose={onClose}
        reload={reload}
      />
    );
  return (
    <NameDialog
      title="New demo"
      label="Name"
      submitLabel="Create"
      onClose={onClose}
      onSubmit={async (name) => {
        const show = await api.createShow(await homeFor(target, name), name);
        go(`/s/${show.id}`);
      }}
    >
      {offer && <ModeSwitch kind="demo" existing={false} onChange={setExisting} />}
      {!current && <ProjectSelect projects={projects} value={target} onChange={setTarget} />}
    </NameDialog>
  );
}

const DECK_ACCEPT = ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/pdf,.pdf,.json";

/** Name it, choose a project, and add the file (click or drag), all in one place. Several files add several decks. */
function NewDeckDialog({
  projects,
  current,
  loose,
  reload,
  onClose,
  onError,
}: {
  projects: MatterSummary[];
  current?: MatterSummary;
  loose: DeckSummary[];
  reload: () => void;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [existing, setExisting] = useState(false);
  // Only offered inside a project that can take another deck.
  const offer = !!current && loose.length > 0 && !(current.deckMode === "single" && current.deckCount > 0);
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  // Inside a project, the new deck belongs to it; the project dropdown is only for the overview.
  const [target, setTarget] = useState(current ? current.id : NO_PROJECT);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const decks = files.filter((f) => /\.(pdf|pptx)$/i.test(f.name));
  const single = decks.length <= 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const choose = (list: File[]) => {
    if (!list.length) return;
    const found = list.filter((f) => /\.(pdf|pptx)$/i.test(f.name));
    if (!found.length) {
      setProblem(list.some((f) => /\.ppt$/i.test(f.name)) ? "Older .ppt files aren't supported. In PowerPoint, use Save As to make a .pptx." : "Choose a PowerPoint (.pptx) or PDF file.");
      return;
    }
    setProblem(null);
    setFiles(list);
    // The file's name is a good start, but never overwrite one the presenter typed.
    if (!named && found.length === 1) setName(deckTitle(found[0].name));
  };

  const add = async () => {
    const ids: string[] = [];
    try {
      if (single) {
        // A single deck may come with its regions file.
        const { deck, regions } = await pickFiles(files);
        const d = deck ?? decks[0];
        const ext = d.name.match(/\.(pdf|pptx)$/i)?.[0] ?? "";
        const title = name.trim() || deckTitle(d.name);
        ids.push(await addDeck(await homeFor(target, title), title + ext, await d.arrayBuffer(), regions, setBusy));
      } else {
        for (const [i, d] of decks.entries()) {
          const prefix = `${i + 1} of ${decks.length} · `;
          ids.push(await addDeck(await homeFor(target, deckTitle(d.name)), d.name, await d.arrayBuffer(), undefined, (m) => setBusy(prefix + m)));
        }
      }
      onClose();
      go(ids.length === 1 ? `/d/${ids[0]}` : target ? projectPath(target) : tabPath("decks"));
      // The overview doesn't change route when several land without a project.
      if (ids.length > 1 && !target) location.reload();
    } catch (e) {
      onClose();
      onError(`${ids.length ? `${plural(ids.length, "deck")} added, then: ` : ""}${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (existing && current)
    return (
      <ExistingDialog
        kind="deck"
        project={current}
        items={loose.map((d) => ({ id: d.id, name: deckTitle(d.name) }))}
        onSwitch={() => setExisting(false)}
        onClose={onClose}
        reload={reload}
      />
    );

  const ready = decks.length > 0 && (!single || name.trim().length > 0);
  return (
    <div className="overlay" onMouseDown={(e) => !busy && e.target === e.currentTarget && onClose()}>
      <form
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy) add();
        }}
      >
        <h3 className="display">{single ? "New deck" : `Add ${plural(decks.length, "deck")}`}</h3>
        {offer && !busy && <ModeSwitch kind="deck" existing={false} onChange={setExisting} />}
        {busy ? (
          <span className="micro" style={{ color: "var(--ink)" }}>
            {busy}
          </span>
        ) : (
          <>
            {single && (
              <label>
                <span className="micro">Name</span>
                <input
                  className="field"
                  value={name}
                  placeholder="Q4 board update"
                  autoFocus
                  onChange={(e) => {
                    setName(e.target.value);
                    setNamed(e.target.value.trim().length > 0);
                  }}
                />
              </label>
            )}
            {!current && <ProjectSelect projects={projects} value={target} onChange={setTarget} />}
            <button
              type="button"
              className={`dropzone ${over ? "over" : ""} ${decks.length ? "has-file" : ""}`}
              onClick={() => input.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                choose(Array.from(e.dataTransfer.files));
              }}
            >
              {decks.length ? (
                <>
                  <span className="dropzone-title">{decks.length === 1 ? decks[0].name : plural(decks.length, "file")}</span>
                  <span className="hint">Click or drop to choose a different file</span>
                </>
              ) : (
                <>
                  <span className="dropzone-icon" aria-hidden="true">
                    ↑
                  </span>
                  <span className="dropzone-title">Click to upload, or drag a file here</span>
                  <span className="hint">PowerPoint (.pptx) or PDF</span>
                </>
              )}
            </button>
            <input
              ref={input}
              type="file"
              accept={DECK_ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                const list = Array.from(e.target.files ?? []); // the input clears its live FileList once the handler yields
                e.target.value = "";
                choose(list);
              }}
            />
            {problem && <div className="banner err">{problem}</div>}
            {!single && target === NO_PROJECT && <span className="hint">Each deck is added on its own, named after its file.</span>}
            <div className="dialog-actions">
              <button type="button" className="btn ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn primary" disabled={!ready}>
                {single ? "Create deck" : "Add decks"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

function SampleLine({ onError }: { onError: (message: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const trySample = async () => {
    try {
      go(`/d/${await createSampleMatter(setBusy)}`);
    } catch (e) {
      onError(`Couldn't load the sample deck: ${e instanceof Error ? e.message : e}`);
      setBusy(null);
    }
  };
  return (
    <div className="aside-line">
      {busy ?? (
        <>
          New here?{" "}
          <button className="linkish" onClick={trySample}>
            Try the sample deck
          </button>
          . It ships with hand-checked regions, so you can present right away.
        </>
      )}
    </div>
  );
}

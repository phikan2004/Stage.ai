import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DeckSummary, HomeData, MatterSummary, Show } from "../../../shared/schema";
import { api } from "../lib/api";
import { addDeck, createSampleMatter, pickFiles } from "../lib/deck";
import { deckTitle, plural } from "../lib/format";
import { go } from "../lib/router";
import { coverUrl } from "../lib/stage";
import { Loading, NameDialog, TopBar, type Tab } from "./Chrome";

const INTRO: Record<Tab, { title: ReactNode; line: string }> = {
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

export const tabPath = (tab: Tab) => (tab === "projects" ? "/projects" : tab === "demos" ? "/demos" : "/");
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

  return (
    <>
      <TopBar tab={tab} back={projectId ? "/projects" : undefined}>{data && <NewMenu projects={projects} current={project} />}</TopBar>
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
  tab: Tab;
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

  const deleteDeck = async (d: DeckSummary, inProject: boolean) => {
    const runs = d.runCount ? ` and its ${plural(d.runCount, "run")}` : "";
    if (!confirm(`Delete “${deckTitle(d.name)}”${runs}? This can't be undone.`)) return;
    // A deck on its own lives in a hidden matter, which goes with it.
    await (inProject ? api.deleteDeck(d.id) : api.deleteMatter(d.matterId));
    reload();
  };

  const intro = INTRO[tab];
  const what = tab === "projects" ? "projects" : tab === "decks" ? "decks" : "demos";
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
          {shown.map((e) =>
            e.kind === "project" ? (
              <ProjectCard key={e.project.id} project={e.project} demos={(shows ?? []).filter((s) => s.matterId === e.project.id)} />
            ) : e.kind === "deck" ? (
              <DeckCard key={e.deck.id} deck={e.deck} projectName={e.projectName} onDelete={() => deleteDeck(e.deck, !!e.projectName)} />
            ) : (
              <DemoCard key={e.show.id} show={e.show} projectName={e.projectName} />
            ),
          )}
        </div>
      ) : q ? (
        <div className="empty-row">Nothing matches “{query.trim()}”.</div>
      ) : (
        <div className="cards library">
          <StartCard kind={tab === "projects" ? "project" : tab === "decks" ? "deck" : "demo"} hint={`You don't have any ${what} yet.`} />
        </div>
      )}

      {tab === "decks" && data.matters.length === 0 && <SampleLine onError={onError} />}
    </>
  );
}

function ProjectPage({ project, data, shows, reload }: { project: MatterSummary; data: HomeData; shows: Show[] | null; reload: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const decks = data.decks.filter((d) => d.matterId === project.id);
  const demos = (shows ?? []).filter((s) => s.matterId === project.id);
  const counts = [plural(decks.length, "deck"), ...(shows ? [plural(demos.length, "demo")] : [])].join(" · ");

  const deleteProject = async () => {
    if (!confirm(`Delete “${project.name}” with its ${counts.replace(" · ", " and ")}? This can't be undone.`)) return;
    await api.deleteMatter(project.id);
    go(tabPath("projects"));
  };

  const deleteDeck = async (d: DeckSummary) => {
    const runs = d.runCount ? ` and its ${plural(d.runCount, "run")}` : "";
    if (!confirm(`Delete “${deckTitle(d.name)}”${runs}? This can't be undone.`)) return;
    await api.deleteDeck(d.id);
    reload();
  };

  const toggle = (id: string) => setOpen(open === id ? null : id);
  return (
    <>
      <div className="page-head">
        <div>
          <div className="micro">Project · {counts}</div>
          <h1 className="display">{project.name}</h1>
        </div>
        <div className="page-actions">
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
          <div className="rows">
            {decks.map((d) => (
              <Row
                key={d.id}
                open={open === d.id}
                onToggle={() => toggle(d.id)}
                thumb={d.hasThumb ? <img src={api.thumbUrl(d.id)} alt="" /> : null}
                title={deckTitle(d.name)}
                detail={`${plural(d.slideCount, "slide")} · ${plural(d.regionCount, "region")}${d.analyzed ? "" : " · needs analysis"}`}
                href={`#/d/${d.id}`}
                onDelete={() => deleteDeck(d)}
              >
                {d.hasThumb && <img className="row-preview" src={api.thumbUrl(d.id)} alt="" />}
              </Row>
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
          <div className="rows">
            {demos.map((s) => (
              <Row
                key={s.id}
                open={open === s.id}
                onToggle={() => toggle(s.id)}
                thumb={<Cover show={s} />}
                title={s.name}
                detail={`${s.beats.length ? plural(s.beats.length, "cue") : "Not taught yet"}${s.dryRuns.length ? ` · ${plural(s.dryRuns.length, "dry run")}` : ""}`}
                href={`#/s/${s.id}`}
              >
                {s.beats.length > 0 && (
                  <ol className="row-beats">
                    {s.beats.map((b) => (
                      <li key={b.id}>{b.label}</li>
                    ))}
                  </ol>
                )}
              </Row>
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
    </>
  );
}

/** Shown where nothing exists yet; opens the same flow as New, into the open project if there is one. */
function StartCard({ kind, hint }: { kind: NewKind; hint: string }) {
  return (
    <button className="card project-card card-start" onClick={() => startNew(kind)}>
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

/** One item in a project: click to see more, then open it. */
function Row({
  open,
  onToggle,
  thumb,
  title,
  detail,
  href,
  onDelete,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  thumb: ReactNode;
  title: string;
  detail: string;
  href: string;
  onDelete?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className={`row ${open ? "open" : ""}`}>
      <button className="row-head" aria-expanded={open} onClick={onToggle}>
        <span className="row-thumb">{thumb}</span>
        <span className="row-text">
          <span className="card-title">{title}</span>
          <span className="hint">{detail}</span>
        </span>
        <span className="row-chevron" aria-hidden="true">
          ›
        </span>
      </button>
      {open && (
        <div className="row-body">
          {children}
          <div className="row-actions">
            <a className="btn small primary" href={href}>
              Open
            </a>
            {onDelete && (
              <button className="btn small ghost danger" onClick={onDelete}>
                Delete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectCard({ project: p, demos }: { project: MatterSummary; demos: Show[] }) {
  // Its newest deck's first slide, else its newest demo's screenshot.
  const cover = p.thumbDeckId ? undefined : demos.find((s) => coverUrl(s));
  return (
    <a className="card project-card" href={`#${projectPath(p.id)}`}>
      <div className="card-img">
        {p.thumbDeckId && <img src={api.thumbUrl(p.thumbDeckId, p.updatedAt)} alt="" />}
        {cover && <Cover show={cover} />}
        <span className="badge quiet">Project</span>
      </div>
      <div className="card-body">
        <div className="card-title">{p.name}</div>
        <div className="hint">
          {plural(p.deckCount, "deck")} · {plural(demos.length, "demo")}
        </div>
      </div>
    </a>
  );
}

function DeckCard({ deck: d, projectName, onDelete }: { deck: DeckSummary; projectName: string | null; onDelete: () => void }) {
  return (
    <a className="card" href={`#/d/${d.id}`}>
      <div className="card-img">
        {d.hasThumb && <img src={api.thumbUrl(d.id)} alt="" />}
        {!d.analyzed && <span className="badge">Needs analysis</span>}
        <button
          className="card-x"
          title="Delete deck"
          onClick={(e) => {
            e.preventDefault();
            onDelete();
          }}
        >
          ×
        </button>
      </div>
      <div className="card-body">
        <div className="card-title">{deckTitle(d.name)}</div>
        <div className="hint">
          {projectName && `${projectName} · `}
          {plural(d.slideCount, "slide")} · {plural(d.regionCount, "region")}
        </div>
      </div>
    </a>
  );
}

/** A demo's cover screenshot; nothing when the runner can't serve it, so the card stays plain. */
function Cover({ show }: { show: Show }) {
  const [failed, setFailed] = useState(false);
  const url = coverUrl(show);
  return url && !failed ? <img src={url} alt="" onError={() => setFailed(true)} /> : null;
}

/** One dot per cue: green if the last dry run got through it, orange if not, hollow if never tried. */
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

function DemoCard({ show: s, projectName }: { show: Show; projectName: string | null }) {
  return (
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
          {s.dryRuns.length > 0 && ` · ${plural(s.dryRuns.length, "dry run")}`}
        </div>
      </div>
    </a>
  );
}

/** A small menu under a button; closes on a pick, a click elsewhere or Escape. */
function Menu({ label, className, children }: { label: ReactNode; className: string; children: (close: () => void) => ReactNode }) {
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
    <div className="menu-box" ref={box}>
      <button className={className} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
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
function NewMenu({ projects, current }: { projects: MatterSummary[]; current?: MatterSummary }) {
  const [making, setMaking] = useState<"project" | "demo" | null>(null);
  const [files, setFiles] = useState<File[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const pick = (kind: NewKind) => {
    setError(null);
    if (kind === "deck") input.current?.click();
    else setMaking(kind);
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
      <input
        ref={input}
        type="file"
        accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/pdf,.pdf,.json"
        multiple
        hidden
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []); // the input clears its live FileList once the handler yields
          e.target.value = "";
          if (list.length) setFiles(list);
        }}
      />
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
          {making === "demo" && <NewDemoDialog projects={projects} current={current} onClose={() => setMaking(null)} />}
          {files && <AddDecksDialog files={files} projects={projects.filter(canTakeDeck)} current={current} onClose={() => setFiles(null)} onError={setError} />}
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
    <label>
      <span className="micro">Project</span>
      <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value={NO_PROJECT}>No project</option>
        {projects.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    </label>
  );
}

type NewKind = "project" | "deck" | "demo";
const NEW_EVENT = "stage:new";
/** Opens the New menu's flow for one kind, from anywhere on the page. */
const startNew = (kind: NewKind) => window.dispatchEvent(new CustomEvent<NewKind>(NEW_EVENT, { detail: kind }));

/** Where something new goes: the chosen project, or a hidden matter of its own. */
const homeFor = async (projectId: string, name: string) => (projectId === NO_PROJECT ? (await api.createMatter(name, true)).id : projectId);

function NewDemoDialog({ projects, current, onClose }: { projects: MatterSummary[]; current?: MatterSummary; onClose: () => void }) {
  const [target, setTarget] = useState(current?.id ?? NO_PROJECT);
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
      <ProjectSelect projects={projects} value={target} onChange={setTarget} />
    </NameDialog>
  );
}

function AddDecksDialog({
  files,
  projects,
  current,
  onClose,
  onError,
}: {
  files: File[];
  projects: MatterSummary[];
  current?: MatterSummary;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const decks = files.filter((f) => /\.(pdf|pptx)$/i.test(f.name));
  const [target, setTarget] = useState(current && projects.includes(current) ? current.id : NO_PROJECT);
  const [busy, setBusy] = useState<string | null>(null);

  if (!decks.length) {
    const legacy = files.some((f) => f.name.toLowerCase().endsWith(".ppt"));
    onClose();
    onError(legacy ? "Older .ppt files aren't supported. In PowerPoint, use Save As to make a .pptx." : "Choose a PowerPoint (.pptx) or PDF file.");
    return null;
  }

  const add = async () => {
    const ids: string[] = [];
    try {
      if (decks.length === 1) {
        // A single deck may come with its regions file.
        const { deck, regions } = await pickFiles(files);
        const d = deck ?? decks[0];
        ids.push(await addDeck(await homeFor(target, deckTitle(d.name)), d.name, await d.arrayBuffer(), regions, setBusy));
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

  return (
    <div className="overlay" onMouseDown={(e) => !busy && e.target === e.currentTarget && onClose()}>
      <form
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) add();
        }}
      >
        <h3 className="display">{decks.length === 1 ? `Add “${deckTitle(decks[0].name)}”` : `Add ${plural(decks.length, "deck")}`}</h3>
        {busy ? (
          <span className="micro" style={{ color: "var(--ink)" }}>
            {busy}
          </span>
        ) : (
          <>
            <ProjectSelect projects={projects} value={target} onChange={setTarget} />
            {decks.length > 1 && target === NO_PROJECT && <span className="hint">Each deck is added on its own.</span>}
            <div className="dialog-actions">
              <button type="button" className="btn ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn primary">Add</button>
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

import { useCallback, useEffect, useRef, useState } from "react";
import type { DeckSummary, MatterDetail, Show } from "../../../shared/schema";
import { api } from "../lib/api";
import { addDeck, pickFiles } from "../lib/deck";
import { dateTime, deckTitle, plural } from "../lib/format";
import { go } from "../lib/router";
import { Loading, NameDialog, TopBar } from "./Chrome";

export default function MatterView({ id }: { id: string }) {
  const [data, setData] = useState<MatterDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [addingShow, setAddingShow] = useState(false);
  // Separate from the matter, so shows being unavailable can't take the page down.
  const [shows, setShows] = useState<Show[] | null>(null);

  useEffect(() => {
    api.shows(id).then(setShows).catch(() => setShows(null));
  }, [id]);

  const load = useCallback(
    () =>
      api
        .matter(id)
        .then(setData)
        .catch((e) => setError(e instanceof Error ? e.message : String(e))),
    [id],
  );
  useEffect(() => {
    load();
  }, [load]);

  const deleteMatter = async () => {
    if (!data) return;
    const { decks, runs } = data;
    const what = [plural(decks.length, "presentation"), plural(runs.length, "run")].join(" and ");
    if (!confirm(`Delete “${data.matter.name}” with its ${what}? This can't be undone.`)) return;
    await api.deleteMatter(id);
    go("/");
  };

  const deleteDeck = async (d: DeckSummary) => {
    const runs = d.runCount ? ` and its ${plural(d.runCount, "run")}` : "";
    if (!confirm(`Delete “${d.name}”${runs}? This can't be undone.`)) return;
    await api.deleteDeck(d.id);
    load();
  };

  const name = data?.matter.name ?? "";
  return (
    <>
      <TopBar crumbs={[{ label: "Matters", to: "/" }, { label: name || "…" }]} />
      <main className="page">
        {error && <div className="banner err">{error}</div>}
        {!data && !error && <Loading />}
        {data && (
          <>
            <div className="page-head">
              <div>
                <div className="micro">Matter · created {dateTime(data.matter.createdAt)}</div>
                <h1 className="display">{name}</h1>
              </div>
              <div className="page-actions">
                <button className="btn small ghost" onClick={() => setRenaming(true)}>
                  Rename
                </button>
                <button className="btn small ghost danger" onClick={deleteMatter}>
                  Delete matter
                </button>
              </div>
            </div>

            <section className="section first">
              <div className="section-head">
                <h2 className="display">Presentations</h2>
                <span className="hint">{plural(data.decks.length, "deck")}</span>
              </div>
              <div className="cards">
                <AddDeckCard matterId={id} />
                {data.decks.map((d) => (
                  <DeckCard key={d.id} deck={d} onDelete={() => deleteDeck(d)} />
                ))}
              </div>
            </section>

            {shows && (
              <section className="section">
                <div className="section-head">
                  <h2 className="display">Shows</h2>
                  <span className="hint">Demos the Stage operator performs live</span>
                </div>
                <div className="cards">
                  <button className="card card-new" onClick={() => setAddingShow(true)}>
                    <span className="plus">+</span>
                    <span>New show</span>
                    <span className="hint">Do the demo once while talking through it. The AI learns it.</span>
                  </button>
                  {shows.map((s) => (
                    <a key={s.id} className="card" href={`#/s/${s.id}`}>
                      <div className="card-img">
                        <span className="monogram display">{s.beats.length}</span>
                      </div>
                      <div className="card-body">
                        <div className="card-title">{s.name}</div>
                        <div className="hint">{s.beats.length ? plural(s.beats.length, "beat") : "Not taught yet"}</div>
                        <div className="hint">{s.dryRuns.length ? plural(s.dryRuns.length, "dry run") : "No dry runs yet"}</div>
                      </div>
                    </a>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>
      {addingShow && (
        <NameDialog
          title="New show"
          label="Name"
          initial=""
          submitLabel="Create"
          onClose={() => setAddingShow(false)}
          onSubmit={async (n) => {
            const show = await api.createShow(id, n);
            go(`/s/${show.id}`);
          }}
        />
      )}
      {renaming && data && (
        <NameDialog
          title="Rename matter"
          label="Name"
          initial={name}
          submitLabel="Save"
          onClose={() => setRenaming(false)}
          onSubmit={async (n) => {
            await api.renameMatter(id, n);
            setRenaming(false);
            load();
          }}
        />
      )}
    </>
  );
}

function DeckCard({ deck: d, onDelete }: { deck: DeckSummary; onDelete: () => void }) {
  return (
    <a className="card" href={`#/d/${d.id}`}>
      <div className="card-img">
        {d.hasThumb ? <img src={api.thumbUrl(d.id)} alt="" /> : <span className="monogram display">{d.slideCount}</span>}
        {!d.analyzed && <span className="badge">Needs analysis</span>}
        <button
          className="card-x"
          title="Delete presentation"
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
          {plural(d.slideCount, "slide")} · {plural(d.regionCount, "region")}
        </div>
      </div>
    </a>
  );
}

function AddDeckCard({ matterId }: { matterId: string }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const take = async (list: FileList | null) => {
    if (!list || busy) return;
    setError(null);
    const files = Array.from(list); // the input clears its live FileList once the handler yields
    const { deck, regions } = await pickFiles(files);
    if (!deck) {
      const legacy = files.some((f) => f.name.toLowerCase().endsWith(".ppt"));
      return setError(legacy ? "Older .ppt files aren't supported. In PowerPoint, use Save As to make a .pptx." : "Choose a PowerPoint (.pptx) or PDF file.");
    }
    try {
      const deckId = await addDeck(matterId, deck.name, await deck.arrayBuffer(), regions, setBusy);
      go(`/d/${deckId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  return (
    <div
      className={`card card-new drop-card ${over ? "over" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => !busy && input.current?.click()}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        take(e.dataTransfer.files);
      }}
    >
      {busy ? (
        <span className="micro" style={{ color: "var(--ink)" }}>
          {busy}
        </span>
      ) : (
        <>
          <span className="plus">+</span>
          <span>Add a presentation</span>
          <span className="hint">Drop a PowerPoint or PDF here, or click to choose. Add its .regions.json too to skip analysis.</span>
        </>
      )}
      {error && <span className="hint" style={{ color: "var(--err)" }}>{error}</span>}
      <input
        ref={input}
        type="file"
        accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/pdf,.pdf,.json"
        multiple
        hidden
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          take(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

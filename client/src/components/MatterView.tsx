import { useCallback, useEffect, useRef, useState } from "react";
import type { DeckSummary, MatterDetail } from "../../../shared/schema";
import { api } from "../lib/api";
import { addDeck, pickFiles } from "../lib/deck";
import { dateTime, deckTitle, plural } from "../lib/format";
import { go } from "../lib/router";
import { Loading, NameDialog, TopBar } from "./Chrome";

export default function MatterView({ id }: { id: string }) {
  const [data, setData] = useState<MatterDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

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
                {(data.matter.deckMode !== "single" || data.decks.length === 0) && <AddDeckCard matterId={id} />}
                {data.decks.map((d) => (
                  <DeckCard key={d.id} deck={d} onDelete={() => deleteDeck(d)} />
                ))}
              </div>
            </section>
          </>
        )}
      </main>
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
          <span className="hint">Drop a PowerPoint or PDF here, or click to choose.</span>
        </>
      )}
      {error && <span className="hint" style={{ color: "var(--err)" }}>{error}</span>}
      <input
        ref={input}
        type="file"
        accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/pdf,.pdf"
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

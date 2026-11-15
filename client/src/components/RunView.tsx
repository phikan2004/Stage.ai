import { useEffect, useMemo, useState } from "react";
import type { RunDetail, RunEvent } from "../../../shared/schema";
import { api } from "../lib/api";
import { CUE_PAST_TENSE } from "../lib/cues";
import { clock, dateTime, deckTitle, duration } from "../lib/format";
import { go } from "../lib/router";
import { Loading, TopBar } from "./Chrome";

type Item =
  | { kind: "zoom"; t: number; label: string; verb: string }
  | { kind: "command"; t: number; text: string }
  | { kind: "said"; t: number; text: string; simulated: boolean };

interface Segment {
  slide: number;
  start: number;
  end: number;
  items: Item[];
}

/** Group a run's events into one segment per stretch of time on a slide. */
function segments(events: RunEvent[], total: number): Segment[] {
  const out: Segment[] = [];
  for (const e of events) {
    let seg = out.at(-1);
    if (e.type === "slide" || !seg) {
      if (seg) seg.end = e.t;
      seg = { slide: e.slide, start: e.t, end: total, items: [] };
      out.push(seg);
      if (e.type === "slide") continue;
    }
    if (e.type === "zoom") seg.items.push({ kind: "zoom", t: e.t, label: e.label, verb: CUE_PAST_TENSE[e.cue ?? "zoom"] });
    else if (e.type === "command") seg.items.push({ kind: "command", t: e.t, text: e.text });
    else if (e.type === "heard") {
      const prev = seg.items.at(-1);
      const simulated = !!e.simulated;
      if (prev?.kind === "said" && prev.simulated === simulated) prev.text += ` ${e.text}`;
      else seg.items.push({ kind: "said", t: e.t, text: e.text, simulated });
    }
  }
  return out;
}

const ENGINES: Record<string, string> = { deepgram: "Deepgram", chrome: "Chrome speech" };

export default function RunView({ id }: { id: string }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .run(id)
      .then(setRun)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  const segs = useMemo(() => (run ? segments(run.events, run.stats.durationMs) : []), [run]);

  const remove = async () => {
    if (!run || !confirm("Delete this run from the history?")) return;
    await api.deleteRun(id);
    go(`/m/${run.matterId}`);
  };

  const deckLabel = run ? deckTitle(run.deckName) : "…";
  const crumbs = [
    { label: run?.matterName || "…", to: run ? `/m/${run.matterId}` : undefined },
    { label: run ? `Run · ${dateTime(run.startedAt)}` : "Run" },
  ];

  return (
    <>
      <TopBar tab="decks" crumbs={crumbs} />
      <main className="page">
        {error && <div className="banner err">{error}</div>}
        {!run && !error && <Loading />}
        {run && (
          <>
            <div className="page-head">
              <div>
                <div className="micro">
                  Run · {dateTime(run.startedAt)}
                  {run.engine && ` · ${ENGINES[run.engine] ?? run.engine}`}
                </div>
                <h1 className="display">{deckLabel}</h1>
              </div>
              <div className="page-actions">
                {run.deckExists && (
                  <a className="btn small" href={`#/d/${run.deckId}`}>
                    Open presentation
                  </a>
                )}
                <button className="btn small ghost danger" onClick={remove}>
                  Delete run
                </button>
              </div>
            </div>

            <div className="stats">
              <Stat label="Length" value={duration(run.stats.durationMs)} />
              <Stat label="Slides shown" value={`${run.stats.slidesVisited}`} sub={`of ${run.slideCount}`} />
              <Stat label="Cues" value={`${run.stats.zooms}`} />
              <Stat label="Voice commands" value={`${run.stats.commands}`} />
              <Stat label="Words heard" value={run.stats.words.toLocaleString()} />
            </div>

            <section className="section">
              <div className="section-head">
                <h2 className="display">Timeline</h2>
                <span className="hint">What happened on each slide, in order</span>
              </div>
              {segs.length === 0 ? (
                <div className="empty-row">Nothing was recorded during this run.</div>
              ) : (
                <div className="timeline">
                  {segs.map((s, i) => (
                    <div className="tl-row" key={i}>
                      <div className="tl-when">
                        <div className="tl-slide">Slide {s.slide + 1}</div>
                        <div className="hint">
                          {clock(s.start)} · {duration(s.end - s.start)}
                        </div>
                      </div>
                      <div className="tl-body">
                        {s.items.length === 0 && <div className="hint">Nothing heard on this slide.</div>}
                        {s.items.map((it, j) =>
                          it.kind === "said" ? (
                            <p key={j} className={`tl-said ${it.simulated ? "sim" : ""}`}>
                              <span className="tl-t">{clock(it.t)}</span>
                              {it.simulated && <span className="hint">Simulated: </span>}
                              {it.text}
                            </p>
                          ) : (
                            <div key={j} className={`tl-ev ${it.kind}`}>
                              <span className="tl-t">{clock(it.t)}</span>
                              {it.kind === "zoom" ? (
                                <>
                                  {it.verb} <b>{it.label}</b>
                                </>
                              ) : (
                                <>Voice command “{it.text}”</>
                              )}
                            </div>
                          ),
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="micro">{label}</div>
      <div className="stat-v display">
        {value}
        {sub && <span className="hint"> {sub}</span>}
      </div>
    </div>
  );
}

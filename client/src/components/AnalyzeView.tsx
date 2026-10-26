import { useEffect, useRef, useState } from "react";
import type { Region } from "../../../shared/schema";
import type { Deck } from "../lib/deck";
import { analyzeAll, type SlideStatus } from "../lib/analyzeQueue";

interface Props {
  deck: Deck;
  onRegions: (index: number, regions: Region[]) => void;
  onDone: () => void;
}

type Health = { ok: boolean; hasKey: boolean; model: string } | null;

export default function AnalyzeView({ deck, onRegions, onDone }: Props) {
  // Slides that already have regions (e.g. analysis was interrupted earlier) aren't re-run.
  const [statuses, setStatuses] = useState<SlideStatus[]>(() =>
    deck.images.map((_, i) => {
      const count = deck.slides[i]?.regions.length ?? 0;
      return count ? { state: "done", count } : { state: "pending" };
    }),
  );
  const [health, setHealth] = useState<Health | "down">(null);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const run = async (only?: number[]) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setRunning(true);
    const indices = only ?? deck.images.map((_, i) => i).filter((i) => !deck.slides[i]?.regions.length);
    if (indices.length === 0) return setRunning(false);
    await analyzeAll(
      indices.map((i) => deck.images[i].url),
      (k, status, regions) => {
        const i = indices[k];
        setStatuses((s) => s.map((x, j) => (j === i ? status : x)));
        if (regions) onRegions(i, regions);
      },
      { concurrency: 2, signal: ctrl.signal },
    );
    if (!ctrl.signal.aborted) setRunning(false);
  };

  useEffect(() => {
    let alive = true;
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => {
        if (!alive) return;
        setHealth(h);
        if (h.hasKey) run();
      })
      .catch(() => alive && setHealth("down"));
    return () => {
      alive = false;
      abort.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const done = statuses.filter((s) => s.state === "done" || s.state === "error").length;
  const failed = statuses.map((s, i) => (s.state === "error" ? i : -1)).filter((i) => i >= 0);
  const finished = done === statuses.length && !running;

  return (
    <main className="analyze">
      <div className="micro">Analyze</div>
      <h2 className="display">Finding regions on each slide</h2>

      {health === "down" && (
        <div className="banner err">
          The Producer server isn't reachable. Start everything with <code>npm run dev</code>, or skip ahead and draw
          regions by hand.
        </div>
      )}
      {health && health !== "down" && !health.hasKey && (
        <div className="banner">
          No <code>ANTHROPIC_API_KEY</code> on the server, so automatic analysis is off. Add it to <code>.env</code>, or
          skip to review and draw regions by hand.
        </div>
      )}
      {health && health !== "down" && health.hasKey && (
        <div className="hint">
          Using <b>{health.model}</b>. {done} of {statuses.length} slides processed.
        </div>
      )}

      <div className="progress">
        <div style={{ width: `${(done / statuses.length) * 100}%` }} />
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 28, flexWrap: "wrap" }}>
        <button className="btn primary" onClick={onDone} disabled={running}>
          {finished ? "Review regions →" : "Skip to review"}
        </button>
        {failed.length > 0 && !running && (
          <button className="btn" onClick={() => run(failed)}>
            Retry {failed.length} failed
          </button>
        )}
      </div>

      <div className="grid">
        {deck.images.map((img, i) => {
          const s = statuses[i];
          return (
            <div className="thumb" key={i}>
              <img src={img.url} alt={`Slide ${i + 1}`} />
              <div className="meta">
                <span className="micro">Slide {i + 1}</span>
                <span className={`status ${s.state}`} title={s.state === "error" ? s.message : undefined}>
                  {s.state === "pending" && "Queued"}
                  {s.state === "running" && "Analyzing…"}
                  {s.state === "done" && `${s.count} regions`}
                  {s.state === "error" && "Failed"}
                </span>
              </div>
              {s.state === "error" && (
                <div className="hint" style={{ padding: "0 12px 10px", color: "var(--err)" }}>
                  {s.message}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}

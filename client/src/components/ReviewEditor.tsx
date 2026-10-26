import { useEffect, useRef, useState } from "react";
import { clampBox, normalizeRegions, type Box, type Region } from "../../../shared/schema";
import type { Deck } from "../lib/deck";
import { analyzeImage } from "../lib/analyzeQueue";
import { hue } from "../lib/useConfig";

interface Props {
  deck: Deck;
  initialIndex: number;
  onRegions: (index: number, regions: Region[]) => void;
  onDownload: () => void;
  onImport: (text: string) => void;
  onPresent: (from: number) => void;
}

type DragKind = "move" | "nw" | "ne" | "sw" | "se" | "draw";
interface Drag {
  kind: DragKind;
  id?: string;
  x0: number;
  y0: number;
  orig?: Box;
  moved: boolean;
  /** latest drawn box; kept here so pointerup never reads stale state */
  box?: Box;
}

const MIN = 0.02;
const pct = (n: number) => `${n * 100}%`;
const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
};

function resize(kind: DragKind, o: Box, dx: number, dy: number): Box {
  let { x, y, w, h } = o;
  if (kind === "nw" || kind === "sw") {
    const nx = Math.min(x + w - MIN, Math.max(0, x + dx));
    w += x - nx;
    x = nx;
  }
  if (kind === "ne" || kind === "se") w = Math.max(MIN, Math.min(1 - x, w + dx));
  if (kind === "nw" || kind === "ne") {
    const ny = Math.min(y + h - MIN, Math.max(0, y + dy));
    h += y - ny;
    y = ny;
  }
  if (kind === "sw" || kind === "se") h = Math.max(MIN, Math.min(1 - y, h + dy));
  return { x, y, w, h };
}

export default function ReviewEditor({ deck, initialIndex, onRegions, onDownload, onImport, onPresent }: Props) {
  const [index, setIndex] = useState(Math.min(initialIndex, deck.images.length - 1));
  const [selected, setSelected] = useState<string | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [draft, setDraft] = useState<Box | null>(null);
  const [reanalyzing, setReanalyzing] = useState<string | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  const image = deck.images[index];
  const regions = deck.slides[index]?.regions ?? [];
  const sel = regions.find((r) => r.id === selected) ?? null;
  const aspect = image.width / image.height;

  const setRegions = (next: Region[]) => onRegions(index, next);
  const patch = (id: string, p: Partial<Region>) => setRegions(regions.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const remove = (id: string) => {
    setRegions(regions.filter((r) => r.id !== id));
    setSelected(null);
  };

  // keyboard: arrows switch slides, Delete removes the selected region, Esc deselects
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") setIndex((i) => Math.min(deck.images.length - 1, i + 1));
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") setIndex((i) => Math.max(0, i - 1));
      else if ((e.key === "Delete" || e.key === "Backspace") && selected) remove(selected);
      else if (e.key === "Escape") {
        setSelected(null);
        setDrawMode(false);
      } else if (e.key.toLowerCase() === "n") setDrawMode((d) => !d);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => setSelected(null), [index]);

  const point = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = point(e);
    const el = e.target as HTMLElement;
    const handle = el.dataset.handle as DragKind | undefined;
    const id = el.closest<HTMLElement>("[data-region]")?.dataset.region;
    canvas.current!.setPointerCapture(e.pointerId);
    if (!drawMode && id) {
      const r = regions.find((x) => x.id === id)!;
      setSelected(id);
      drag.current = { kind: handle ?? "move", id, x0: p.x, y0: p.y, orig: r.box, moved: false };
    } else {
      drag.current = { kind: "draw", x0: p.x, y0: p.y, moved: false };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = point(e);
    const dx = p.x - d.x0;
    const dy = p.y - d.y0;
    if (Math.abs(dx) + Math.abs(dy) > 0.004) d.moved = true;
    if (!d.moved) return;
    if (d.kind === "draw") {
      d.box = { x: Math.min(d.x0, p.x), y: Math.min(d.y0, p.y), w: Math.abs(dx), h: Math.abs(dy) };
      setDraft(d.box);
    } else if (d.kind === "move" && d.orig && d.id) {
      const o = d.orig;
      const box = { ...o, x: Math.min(1 - o.w, Math.max(0, o.x + dx)), y: Math.min(1 - o.h, Math.max(0, o.y + dy)) };
      patch(d.id, { box });
    } else if (d.orig && d.id) {
      patch(d.id, { box: resize(d.kind, d.orig, dx, dy) });
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "draw") {
      const box = d.box;
      if (d.moved && box && box.w > MIN && box.h > MIN) {
        const fresh: Region = { id: `region-${Date.now().toString(36)}`, label: "New region", description: "", keywords: [], box: clampBox(box) };
        const next = normalizeRegions([...regions, fresh]);
        setRegions(next);
        setSelected(next.at(-1)!.id);
        setDrawMode(false);
      } else if (!d.moved) {
        setSelected(null);
      }
      setDraft(null);
    }
  };

  const reanalyze = async () => {
    setReanalyzing("Analyzing…");
    try {
      setRegions(await analyzeImage(image.url));
      setReanalyzing(null);
    } catch (e) {
      setReanalyzing(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="review">
      <aside className="rail">
        {deck.images.map((img, i) => (
          <button key={i} className={i === index ? "active" : ""} onClick={() => setIndex(i)}>
            <img src={img.url} alt={`Slide ${i + 1}`} />
            <span className="n">
              {i + 1} · {deck.slides[i]?.regions.length ?? 0}
            </span>
          </button>
        ))}
      </aside>

      <section className="center">
        <div className="toolbar">
          <button className={`btn small ${drawMode ? "on" : ""}`} onClick={() => setDrawMode((d) => !d)} title="N">
            {drawMode ? "Drawing… drag on the slide" : "+ Draw region"}
          </button>
          <button className="btn small" onClick={reanalyze} disabled={reanalyzing === "Analyzing…"}>
            Re-analyze slide
          </button>
          {reanalyzing && <span className="hint">{reanalyzing}</span>}
          <div className="spacer" />
          <label className="btn small ghost">
            Load regions…
            <input
              type="file"
              accept=".json,application/json"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) onImport(await f.text());
                e.target.value = "";
              }}
            />
          </label>
          <button className="btn small" onClick={onDownload}>
            Download regions
          </button>
          <button className="btn small accent" onClick={() => onPresent(index)}>
            Present ▶
          </button>
        </div>
        <div className="canvas-wrap" style={{ containerType: "size" }}>
          <div
            ref={canvas}
            className={`canvas ${drawMode ? "drawing" : ""}`}
            style={{ width: `min(100cqw, calc(100cqh * ${aspect}))`, aspectRatio: `${aspect}` }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <img src={image.url} alt={`Slide ${index + 1}`} draggable={false} />
            {regions.map((r, i) => (
              <div
                key={r.id}
                data-region={r.id}
                className={`rbox ${r.id === selected ? "sel" : ""}`}
                style={{
                  left: pct(r.box.x),
                  top: pct(r.box.y),
                  width: pct(r.box.w),
                  height: pct(r.box.h),
                  ["--hue" as string]: hue(i),
                  pointerEvents: drawMode ? "none" : undefined,
                }}
              >
                <span className="tag">{r.label}</span>
                {r.id === selected &&
                  (["nw", "ne", "sw", "se"] as const).map((h) => <span key={h} className={`h ${h}`} data-handle={h} />)}
              </div>
            ))}
            {draft && <div className="draft" style={{ left: pct(draft.x), top: pct(draft.y), width: pct(draft.w), height: pct(draft.h) }} />}
          </div>
        </div>
      </section>

      <aside className="side">
        {sel ? (
          <RegionForm key={sel.id} region={sel} onChange={(p) => patch(sel.id, p)} onDelete={() => remove(sel.id)} onClose={() => setSelected(null)} />
        ) : (
          <>
            <div>
              <div className="micro">Slide {index + 1}</div>
              <h3>{regions.length} regions</h3>
            </div>
            <div className="hint">
              Click a box to edit it. Drag to move, pull the corners to resize. Drag on an empty area (or press{" "}
              <span className="kbd">N</span>) to draw a new region. <span className="kbd">Del</span> removes the selected
              one. <span className="kbd">←</span> <span className="kbd">→</span> change slides.
            </div>
            <div className="rlist">
              {regions.map((r, i) => (
                <button key={r.id} onClick={() => setSelected(r.id)} style={{ ["--hue" as string]: hue(i) }}>
                  <span className="swatch" />
                  <span style={{ flex: 1 }}>{r.label}</span>
                  <span className="hint">{r.keywords.length} kw</span>
                </button>
              ))}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function RegionForm({
  region,
  onChange,
  onDelete,
  onClose,
}: {
  region: Region;
  onChange: (p: Partial<Region>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [kw, setKw] = useState(region.keywords.join(", "));
  const commitKeywords = (text: string) =>
    onChange({ keywords: [...new Set(text.split(/[,\n]/).map((k) => k.trim()).filter(Boolean))] });

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div className="micro">Region · {region.id}</div>
        <button className="btn small ghost" onClick={onClose}>
          Done
        </button>
      </div>
      <label>
        <span className="micro">Label</span>
        <input className="field" value={region.label} autoFocus={region.label === "New region"} onChange={(e) => onChange({ label: e.target.value })} />
      </label>
      <label>
        <span className="micro">Description</span>
        <textarea className="field" value={region.description} onChange={(e) => onChange({ description: e.target.value })} />
      </label>
      <label>
        <span className="micro">Keywords, comma separated</span>
        <textarea
          className="field"
          style={{ minHeight: 96 }}
          value={kw}
          onChange={(e) => {
            setKw(e.target.value);
            commitKeywords(e.target.value);
          }}
          placeholder="gross margin, profitability, 61 percent"
        />
      </label>
      <div className="chips">
        {region.keywords.map((k) => (
          <span key={k} className="chip">
            {k}
          </span>
        ))}
      </div>
      <div className="hint">
        Say these words while presenting to zoom here. Include how you'd say numbers out loud ("38 percent"). Words
        that other regions on this slide share count for less.
      </div>
      <div className="hint">
        Box: x {region.box.x.toFixed(3)}, y {region.box.y.toFixed(3)}, w {region.box.w.toFixed(3)}, h {region.box.h.toFixed(3)}
      </div>
      <button className="btn small" style={{ alignSelf: "flex-start", color: "var(--err)" }} onClick={onDelete}>
        Delete region
      </button>
    </>
  );
}

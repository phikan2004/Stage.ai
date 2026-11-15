import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { clampBox, normalizeRegions, type Box, type Cue, type Region } from "../../../shared/schema";
import { api } from "../lib/api";
import { markRegion, type Deck } from "../lib/deck";
import { CUES } from "../lib/cues";
import { placePopup } from "../lib/popupPosition";
import { highlightMarks } from "../lib/textLines";
import { useSuggestCues } from "../lib/useSuggestCues";

interface Props {
  deckId: string;
  deck: Deck;
  /** the deck already has a director's plan */
  planned: boolean;
  initialIndex: number;
  onRegions: (index: number, regions: Region[]) => void;
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
/** Moving a box re-reads what's inside it, once the presenter stops adjusting. */
const REDESCRIBE_MS = 1500;
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

export default function ReviewEditor({ deckId, deck, planned, initialIndex, onRegions, onPresent }: Props) {
  const [index, setIndex] = useState(Math.min(initialIndex, deck.images.length - 1));
  const [selected, setSelected] = useState<string | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [draft, setDraft] = useState<Box | null>(null);
  const [popupAt, setPopupAt] = useState<{ x: number; y: number } | null>(null);
  /** a box that's been drawn but not named: it only becomes a cue once it has a label */
  const [pending, setPending] = useState<Pending | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const slides = useRef(deck.slides);
  slides.current = deck.slides;
  const redescribing = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const { suggest, progress, message } = useSuggestCues({ deckId, deck, planned, onRegions });

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

  /** Work out how a drawn cue will be talked about. It runs after the fact, so it always reads the latest slides. */
  const describe = async (slide: number, id: string) => {
    const region = slides.current[slide]?.regions.find((r) => r.id === id);
    if (!region) return;
    try {
      const img = deck.images[slide];
      const [details, marks] = await Promise.all([
        api.describeRegion(deckId, slide, region.label, region.cue ?? "outline", await markRegion(img, region.box), img.facts?.notes),
        region.cue === "highlight" ? highlightMarks(img, region.box) : undefined,
      ]);
      const current = slides.current[slide]?.regions ?? [];
      onRegions(
        slide,
        current.map((r) => (r.id === id ? { ...r, ...details, ...(marks ? { marks } : {}) } : r)),
      );
    } catch (e) {
      // The label still works as a trigger, so a failure here doesn't lose the cue.
      console.error("couldn't describe region", e);
    }
  };

  /** Switching a saved cue to Highlight only needs its lines, which come from the slide with no Claude call. */
  const refreshMarks = async (slide: number, region: Region) => {
    const marks = await highlightMarks(deck.images[slide], region.box);
    const current = slides.current[slide]?.regions ?? [];
    onRegions(slide, current.map((r) => (r.id === region.id ? { ...r, marks } : r)));
  };

  const describeSoon = (slide: number, id: string) => {
    clearTimeout(redescribing.current.get(id));
    redescribing.current.set(id, setTimeout(() => describe(slide, id), REDESCRIBE_MS));
  };

  /** Close the popup. A drawn box with no label just disappears, so it's never saved. */
  const closePopup = () => {
    if (pending?.label.trim()) {
      const fresh: Region = {
        id: `region-${Date.now().toString(36)}`,
        label: pending.label.trim(),
        description: "",
        keywords: [],
        phrases: [],
        cue: pending.cue,
        box: clampBox(pending.box),
      };
      const next = normalizeRegions([...(slides.current[pending.slide]?.regions ?? []), fresh]);
      onRegions(pending.slide, next);
      describeSoon(pending.slide, next.at(-1)!.id);
    }
    setPending(null);
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

  // The popup follows its box, so this runs after layout, when both can be measured.
  useLayoutEffect(() => {
    if (!selected && !pending) return setPopupAt(null);
    const place = () => {
      const target = selected ? `[data-region="${CSS.escape(selected)}"]` : ".draft";
      const box = canvas.current?.querySelector(target)?.getBoundingClientRect();
      const host = area.current?.getBoundingClientRect();
      const size = popup.current?.getBoundingClientRect();
      if (!box || !host || !size) return;
      setPopupAt(
        placePopup(
          { x: box.left - host.left, y: box.top - host.top, w: box.width, h: box.height },
          { w: size.width, h: size.height },
          { w: host.width, h: host.height },
        ),
      );
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [selected, sel?.box, pending?.box, index]);

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
    if (el.dataset.delete && id) return remove(id);
    canvas.current!.setPointerCapture(e.pointerId);
    closePopup();
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
        setPending({ slide: index, box: clampBox(box), label: "", cue: "outline" });
        setDrawMode(false);
      }
      setDraft(null);
    } else if (d?.moved && d.id) {
      describeSoon(index, d.id);
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
          <button className="btn small" onClick={suggest} disabled={!!progress}>
            Suggest cues
          </button>
          <span className="hint">
            {progress ?? message ?? (regions.length ? "Drag on the slide to add a cue" : "Drag on the slide to add a cue, or have Claude suggest them")}
          </span>
          <div className="spacer" />
          <button className="btn small accent" onClick={() => onPresent(index)}>
            Present ▶
          </button>
        </div>
        <div
          ref={area}
          className="canvas-wrap"
          style={{ containerType: "size" }}
          onPointerDown={(e) => e.target === e.currentTarget && closePopup()}
        >
          <div
            ref={canvas}
            className={`canvas ${drawMode ? "drawing" : ""}`}
            style={{ width: `min(100cqw, calc(100cqh * ${aspect}))`, aspectRatio: `${aspect}` }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            // Pressing the slide closes the popup itself, so focus staying put keeps that from happening twice.
            onMouseDown={(e) => e.preventDefault()}
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
                  pointerEvents: drawMode ? "none" : undefined,
                }}
              >
                <span className="tag">{r.label}</span>
                {r.id === selected && (
                  <>
                    {(["nw", "ne", "sw", "se"] as const).map((h) => (
                      <span key={h} className={`h ${h}`} data-handle={h} />
                    ))}
                    <span className="x" data-delete="1" title="Delete">
                      ×
                    </span>
                  </>
                )}
              </div>
            ))}
            {(draft ?? (pending?.slide === index ? pending.box : null)) && (
              <DraftBox box={(draft ?? pending?.box)!} />
            )}
          </div>
          {(pending || sel) && (
            <CuePopup
              key={pending ? "new" : sel!.id}
              ref={popup}
              label={pending ? pending.label : sel!.label}
              cue={pending ? pending.cue : (sel!.cue ?? "zoom")}
              at={popupAt}
              onLabel={(label) => (pending ? setPending({ ...pending, label }) : patch(sel!.id, { label }))}
              onCue={(cue) => {
                if (pending) return setPending({ ...pending, cue });
                patch(sel!.id, { cue });
                if (cue === "highlight") refreshMarks(index, sel!);
              }}
              onClose={closePopup}
              onCancel={() => {
                setPending(null);
                setSelected(null);
              }}
            />
          )}
        </div>
      </section>
    </div>
  );
}

interface Pending {
  slide: number;
  box: Box;
  label: string;
  cue: Cue;
}

function DraftBox({ box }: { box: Box }) {
  return <div className="draft" style={{ left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) }} />;
}

function CuePopup({
  ref,
  label,
  cue,
  at,
  onLabel,
  onCue,
  onClose,
  onCancel,
}: {
  ref: React.Ref<HTMLDivElement>;
  label: string;
  cue: Cue;
  at: { x: number; y: number } | null;
  onLabel: (label: string) => void;
  onCue: (cue: Cue) => void;
  /** finished with it: keeps the cue if it has a label */
  onClose: () => void;
  onCancel: () => void;
}) {
  // A saved cue can't lose its name, so clearing the box leaves the last label in place.
  const [text, setText] = useState(label);
  return (
    <div
      ref={ref}
      className="cue-popup"
      style={at ? { left: at.x, top: at.y } : { left: 0, top: 0, opacity: 0 }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onClose();
      }}
    >
      <label>
        <span className="micro">Label</span>
        <input
          className="field"
          value={text}
          placeholder="Name this cue"
          autoFocus
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value.trim()) onLabel(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") onClose();
            if (e.key === "Escape") onCancel();
          }}
        />
      </label>
      <div>
        <span className="micro">Cue</span>
        <div className="seg">
          {CUES.map(([value, name]) => (
            // Choosing a cue shouldn't take focus from the label, or that would count as leaving the popup.
            <button key={value} className={cue === value ? "on" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => onCue(value)}>
              {name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

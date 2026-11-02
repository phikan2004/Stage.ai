import { useCallback, useEffect, useRef, useState } from "react";
import type { DeckDetail, Region, RunInput, Slide } from "../../../shared/schema";
import { api } from "../lib/api";
import { cacheImages, cachedImages, renderDeck, takeNotices, type Deck } from "../lib/deck";
import { deckTitle } from "../lib/format";
import { Loading, TopBar } from "./Chrome";
import PresentView from "./PresentView";
import ReviewEditor from "./ReviewEditor";

type Stage = "review" | "present";
type SaveState = "saved" | "saving" | "error";

const SAVE_DEBOUNCE_MS = 600;
/** Opening the presenter by accident and leaving straight away isn't worth a history entry. */
const MIN_RUN_MS = 5000;

export default function DeckView({ id }: { id: string }) {
  const [detail, setDetail] = useState<DeckDetail | null>(null);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [stage, setStage] = useState<Stage>("review");
  const [startSlide, setStartSlide] = useState(0);
  const [loading, setLoading] = useState<string | null>("Loading…");
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  /** last slides the server has; pending = waiting to be sent */
  const saved = useRef<Slide[] | null>(null);
  const pending = useRef<Slide[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  /* ---------- load ---------- */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await api.deck(id);
        if (!alive) return;
        setDetail(d);
        let images = cachedImages(id);
        if (!images) {
          setLoading("Loading presentation…");
          const bytes = await api.deckFile(id);
          images = await renderDeck(bytes, (done, total) => alive && setLoading(`Rendering slide ${done} of ${total}…`));
          cacheImages(id, images);
        }
        if (!alive) return;
        // Align stored slides with the rendered pages.
        const slides: Slide[] = images.map((_, index) => ({ index, regions: d.slides.find((s) => s.index === index)?.regions ?? [] }));
        saved.current = slides;
        setDeck({ name: d.name, hash: d.pdfHash, images, slides });
        setWarnings(takeNotices(id));
        setLoading(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  /* ---------- autosave regions ---------- */
  const flush = useCallback(
    async (keepalive = false) => {
      clearTimeout(timer.current);
      const slides = pending.current;
      if (!slides) return;
      pending.current = null;
      try {
        await api.patchDeck(id, { slides }, keepalive);
        saved.current = slides;
        if (!pending.current) setSaveState("saved");
      } catch {
        pending.current ??= slides;
        setSaveState("error");
      }
    },
    [id],
  );

  useEffect(() => {
    if (!deck || deck.slides === saved.current || deck.slides === pending.current) return;
    pending.current = deck.slides;
    setSaveState("saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => flush(), SAVE_DEBOUNCE_MS);
  }, [deck, flush]);

  useEffect(() => {
    const onUnload = () => flush(true);
    window.addEventListener("pagehide", onUnload);
    return () => {
      window.removeEventListener("pagehide", onUnload);
      flush(true);
    };
  }, [flush]);

  /* ---------- editing ---------- */
  const setRegions = useCallback((index: number, regions: Region[]) => {
    setDeck((d) => d && { ...d, slides: d.slides.map((s) => (s.index === index ? { ...s, regions } : s)) });
  }, []);

  /* ---------- presenting ---------- */
  const present = (from: number) => {
    setStartSlide(from);
    setStage("present");
    // Must be called inside the click handler's user gesture.
    document.documentElement.requestFullscreen?.().catch(() => {});
  };

  const onRunEnd = useCallback(
    (run: Omit<RunInput, "deckId">, unloading: boolean) => {
      if (run.endedAt - run.startedAt < MIN_RUN_MS) return;
      const input = { ...run, deckId: id };
      if (unloading) {
        api.beaconRun(input);
        return;
      }
      api.saveRun(input).catch((e) => console.error("Couldn't save this run", e));
    },
    [id],
  );

  if (stage === "present" && deck) {
    return (
      <PresentView
        deck={deck}
        startIndex={startSlide}
        onRunEnd={onRunEnd}
        onExit={(at) => {
          setStartSlide(at);
          setStage("review");
          if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        }}
      />
    );
  }

  const crumbs = [
    { label: "Matters", to: "/" },
    { label: detail?.matterName || "…", to: detail ? `/m/${detail.matterId}` : undefined },
    { label: detail ? deckTitle(detail.name) : "…" },
  ];

  return (
    <div className="deck-page">
      <TopBar crumbs={crumbs}>
        {deck && (
          <>
            <span className={`save-state ${saveState}`}>
              {saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Saved"}
            </span>
          </>
        )}
      </TopBar>

      {(error || warnings.length > 0) && (
        <div className="banners">
          {error && <div className="banner err">{error}</div>}
          {warnings.map((w) => (
            <div key={w} className="banner">
              {w}
            </div>
          ))}
        </div>
      )}

      {!deck && !error && <Loading text={loading ?? "Loading…"} />}

      {deck && stage === "review" && (
        <ReviewEditor
          deckId={id}
          deck={deck}
          planned={Boolean(detail?.plan)}
          initialIndex={startSlide}
          onRegions={setRegions}
          onPresent={present}
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MAX_RUN_EVENTS, type RunEvent, type RunInput } from "../../../shared/schema";
import type { Deck } from "../lib/deck";
import { ZoomDirector } from "../engine/director";
import type { RegionScore } from "../engine/matcher";
import type { Action, Phase } from "../engine/restraint";
import { computeZoom, IDENTITY, toCss } from "../engine/zoom";
import { useConfig } from "../lib/useConfig";
import { useMicLevel } from "../lib/useMicLevel";
import { ScriptedSpeechSource } from "../speech/ScriptedSpeechSource";
import type { SpeechStatus } from "../speech/SpeechSource";
import { DeepgramSpeechSource } from "../speech/DeepgramSpeechSource";
import { WebSpeechSource } from "../speech/WebSpeechSource";
import { keytermsFor } from "../engine/keyterms";
import { COMMAND_KEYTERMS, parseCommand, type Command } from "../engine/commands";
import type { SpeechSource } from "../speech/SpeechSource";
import DebugPanel from "./DebugPanel";

interface Props {
  deck: Deck;
  startIndex: number;
  onExit: (index: number) => void;
  /** Called once when presenting ends (including tab close, with `unloading` set). */
  onRunEnd: (run: Omit<RunInput, "deckId">, unloading: boolean) => void;
}

export interface Snapshot {
  scores: RegionScore[];
  phase: Phase;
  regionId: string | null;
  finals: string;
  interim: string;
}

const TICK_MS = 100;
export type Engine = "deepgram" | "chrome";
const ENGINE_KEY = "producer.engine";
const VOICE_CMDS_KEY = "producer.voiceCommands";
/** Ignore a second command this soon after one, so an echoed final can't double-advance. */
const COMMAND_COOLDOWN_MS = 800;

const keyterms = (regions: Parameters<typeof keytermsFor>[0]) => [...COMMAND_KEYTERMS, ...keytermsFor(regions, 44)];

function savedEngine(): Engine | null {
  try {
    const v = localStorage.getItem(ENGINE_KEY);
    return v === "deepgram" || v === "chrome" ? v : null;
  } catch {
    return null;
  }
}
const now = () => performance.now();

type EventInput = { [K in RunEvent["type"]]: Omit<Extract<RunEvent, { type: K }>, "t"> }[RunEvent["type"]];

export default function PresentView({ deck, startIndex, onExit, onRunEnd }: Props) {
  const [config, setConfig] = useConfig();
  const [index, setIndex] = useState(startIndex);
  const [zoomId, setZoomId] = useState<string | null>(null);
  const [lastZoomId, setLastZoomId] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [debug, setDebug] = useState(false);
  const [outlines, setOutlines] = useState(false);
  const [mic, setMic] = useState<{ status: SpeechStatus; detail?: string }>({ status: "idle" });
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [helpVisible, setHelpVisible] = useState(true);
  const [speechLog, setSpeechLog] = useState<string[]>([]);
  const micLevel = useMicLevel(debug);
  // null until /api/health answers; Deepgram when the server has a key, unless the user picked Chrome.
  const [engine, setEngineState] = useState<Engine | null>(null);
  const [hasDeepgram, setHasDeepgram] = useState(false);
  const speechSource = useRef<SpeechSource | null>(null);
  const [voiceCmds, setVoiceCmdsState] = useState(() => {
    try {
      return localStorage.getItem(VOICE_CMDS_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const lastCommandAt = useRef(-Infinity);

  const director = useRef<ZoomDirector>(null as unknown as ZoomDirector);
  director.current ??= new ZoomDirector(config);
  const sim = useMemo(() => new ScriptedSpeechSource(), []);
  const autoRef = useRef(auto);
  const debugRef = useRef(debug);
  autoRef.current = auto;
  debugRef.current = debug;

  const regions = deck.slides[index]?.regions ?? [];
  const image = deck.images[index];
  const indexRef = useRef(index);
  const regionsRef = useRef(regions);
  indexRef.current = index;
  regionsRef.current = regions;

  // Run history: what happened while presenting, saved when the presenter closes.
  const runLog = useRef({ startedAt: Date.now(), t0: now(), events: [] as RunEvent[] });
  const record = useCallback((e: EventInput) => {
    const log = runLog.current;
    if (log.events.length < MAX_RUN_EVENTS) log.events.push({ ...e, t: Math.round(now() - log.t0) } as RunEvent);
  }, []);
  const engineRef = useRef<Engine | null>(null);
  const onRunEndRef = useRef(onRunEnd);
  onRunEndRef.current = onRunEnd;
  useEffect(() => {
    let finished = false;
    const finish = (unloading: boolean) => {
      if (finished) return;
      finished = true;
      const { startedAt, events } = runLog.current;
      onRunEndRef.current({ startedAt, endedAt: Date.now(), engine: engineRef.current, events: [...events] }, unloading);
    };
    const onHide = () => finish(true);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      finish(false);
    };
  }, []);

  const apply = useCallback(
    (a: Action) => {
      if (a.type === "zoomTo") {
        setZoomId(a.regionId);
        setLastZoomId(a.regionId);
        const region = regionsRef.current.find((r) => r.id === a.regionId);
        record({ type: "zoom", slide: indexRef.current, regionId: a.regionId, label: region?.label ?? a.regionId, cue: region?.cue });
      } else if (a.type === "zoomOut") {
        setZoomId(null);
      }
    },
    [record],
  );

  useEffect(() => director.current.setConfig(config), [config]);

  // Slide change → immediate zoom-out and a fresh transcript window.
  useEffect(() => {
    // StrictMode runs this twice on mount; don't log the same slide twice in a row.
    const last = [...runLog.current.events].reverse().find((e) => e.type === "slide");
    if (last?.slide !== index) record({ type: "slide", slide: index });
    apply(director.current.setSlide(regions, now()));
    // regions are fixed while presenting; index is the trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, apply, record]);

  useEffect(() => {
    let alive = true;
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => {
        if (!alive) return;
        setHasDeepgram(Boolean(h.hasDeepgram));
        setEngineState(savedEngine() ?? (h.hasDeepgram ? "deepgram" : "chrome"));
      })
      .catch(() => alive && setEngineState("chrome"));
    return () => {
      alive = false;
    };
  }, []);

  const setEngine = useCallback((e: Engine) => {
    try {
      localStorage.setItem(ENGINE_KEY, e);
    } catch {
      /* ignore */
    }
    setEngineState(e);
  }, []);

  // Speech: real mic + the debug "simulate" box both feed the same director.
  useEffect(() => {
    if (!engine) return;
    engineRef.current = engine;
    const source: SpeechSource = engine === "deepgram" ? new DeepgramSpeechSource() : new WebSpeechSource();
    speechSource.current = source;
    source.setKeyterms?.(keyterms(deck.slides[index]?.regions ?? []));
    const log = (line: string) => {
      const stamp = new Date().toLocaleTimeString([], { hour12: false });
      setSpeechLog((l) => [...l.slice(-11), `${stamp}  ${line}`]);
    };
    log(`engine: ${engine === "deepgram" ? "Deepgram" : "Chrome built-in"}`);
    const offs = [source, sim].map((src) =>
      src.onResult((r) => {
        director.current.hear(r.text, r.isFinal, r.timestamp);
        if (!r.isFinal) return;
        const text = r.text.trim();
        if (text) record({ type: "heard", slide: indexRef.current, text, ...(src === sim ? { simulated: true } : {}) });
        commandRef.current(r.text, r.timestamp);
      }),
    );
    offs.push(source.onStatus((status, detail) => setMic({ status, detail })));
    if (source.onLog) offs.push(source.onLog(log));
    offs.push(source.onResult((r) => r.isFinal && log(`heard: "${r.text.trim()}"`)));
    source.start();
    return () => {
      offs.forEach((off) => off());
      source.stop();
      speechSource.current = null;
    };
    // index is read once for the initial keyterms; slide changes update them below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim, engine, record]);

  // Bias recognition toward the current slide's words.
  useEffect(() => {
    speechSource.current?.setKeyterms?.(keyterms(regions));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // The live loop: local and cheap, no network.
  useEffect(() => {
    const id = setInterval(() => {
      const d = director.current;
      const t = now();
      let scores: RegionScore[];
      if (autoRef.current) {
        const r = d.tick(t);
        apply(r.action);
        scores = r.scores;
      } else {
        scores = d.scores(t);
      }
      if (debugRef.current) {
        const text = d.window.text(t, config.windowMs);
        setSnap({ scores, phase: d.current.phase, regionId: d.current.regionId, ...text });
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [apply, config.windowMs]);

  const zoomOutNow = useCallback(() => apply(director.current.zoomOut("manual", now())), [apply]);

  const flash = useCallback((text: string) => setToast({ text, id: now() }), []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 1400);
    return () => clearTimeout(id);
  }, [toast]);

  const setVoiceCmds = useCallback((on: boolean) => {
    try {
      localStorage.setItem(VOICE_CMDS_KEY, on ? "on" : "off");
    } catch {
      /* ignore */
    }
    setVoiceCmdsState(on);
  }, []);

  // Voice commands: "next slide", "go back", "go to slide 3", "zoom out"…
  const runCommand = (cmd: Command) => {
    const last = deck.images.length - 1;
    const go = (target: number, label: string) => {
      if (target === index) return flash(target === last && cmd.type === "next" ? "Last slide" : label);
      setIndex(target);
      flash(label);
    };
    switch (cmd.type) {
      case "next":
        return go(Math.min(last, index + 1), `Slide ${Math.min(last, index + 1) + 1}`);
      case "prev":
        return go(Math.max(0, index - 1), `Slide ${Math.max(0, index - 1) + 1}`);
      case "first":
        return go(0, "Slide 1");
      case "last":
        return go(last, `Slide ${last + 1}`);
      case "goto":
        if (cmd.slide < 1 || cmd.slide > last + 1) return flash(`No slide ${cmd.slide}`);
        return go(cmd.slide - 1, `Slide ${cmd.slide}`);
      case "zoomOut":
        zoomOutNow();
        return flash("Zoomed out");
    }
  };
  const commandRef = useRef<(text: string, t: number) => void>(() => {});
  commandRef.current = (text, t) => {
    if (!voiceCmds) return;
    const cmd = parseCommand(text);
    if (!cmd || t - lastCommandAt.current < COMMAND_COOLDOWN_MS) return;
    lastCommandAt.current = t;
    record({ type: "command", slide: index, command: cmd.type === "goto" ? `goto ${cmd.slide}` : cmd.type, text: text.trim() });
    setSpeechLog((l) => [...l.slice(-11), `command: ${cmd.type}${cmd.type === "goto" ? ` ${cmd.slide}` : ""}`]);
    runCommand(cmd);
  };

  // Keyboard Lock lets Esc reach us in fullscreen (Chrome), so the first Esc can zoom out.
  useEffect(() => {
    const onFs = () => {
      const kb = (navigator as any).keyboard;
      if (document.fullscreenElement) kb?.lock?.(["Escape"]).catch(() => {});
      else {
        kb?.unlock?.();
        zoomOutNow();
      }
    };
    onFs();
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, [zoomOutNow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") {
        if (e.key === "Escape") t.blur();
        return;
      }
      const k = e.key;
      if (k === "ArrowRight" || k === "PageDown" || k === " ") setIndex((i) => Math.min(deck.images.length - 1, i + 1));
      else if (k === "ArrowLeft" || k === "PageUp") setIndex((i) => Math.max(0, i - 1));
      else if (k === "Escape") {
        if (director.current.current.phase === "dwell" || director.current.current.phase === "zoomed" || zoomId) zoomOutNow();
        else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else onExit(index);
      } else if (k === "a" || k === "A") {
        setAuto((on) => {
          if (on) apply(director.current.zoomOut("automationOff", now()));
          return !on;
        });
      } else if (k === "d" || k === "D") setDebug((v) => !v);
      else if (k === "f" || k === "F") {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else document.documentElement.requestFullscreen?.().catch(() => {});
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deck.images.length, index, onExit, zoomId, zoomOutNow, apply]);

  useEffect(() => {
    const id = setTimeout(() => setHelpVisible(false), 4000);
    return () => clearTimeout(id);
  }, []);

  const activeRegion = regions.find((r) => r.id === zoomId);
  const lastRegion = regions.find((r) => r.id === (zoomId ?? lastZoomId));
  const zoomRegion = activeRegion?.cue === "outline" ? undefined : activeRegion;
  const spotRegion = lastRegion?.cue === "outline" ? undefined : lastRegion;
  const outlineRegion = lastRegion?.cue === "outline" ? lastRegion : undefined;
  const transform = zoomRegion ? computeZoom(zoomRegion.box, config.zoomPadding, config.maxZoom) : IDENTITY;
  const ease = `${config.transitionMs}ms cubic-bezier(.22,.61,.36,1)`;
  const pad = config.zoomPadding * 0.5;

  const micLabel =
    mic.status === "listening"
      ? "Listening"
      : mic.status === "restarting"
        ? "Reconnecting"
        : mic.status === "unsupported"
          ? "No mic: press D to simulate"
          : mic.status === "error"
            ? "Mic problem: press D"
            : "Mic off";

  return (
    <div className={`present ${helpVisible || debug ? "" : "hide-cursor"}`} onMouseMove={() => setHelpVisible(true)}>
      <div className="slide-frame" style={{ ["--aspect" as string]: `${image.width / image.height}` }}>
        <div className="slide-inner" style={{ transform: toCss(transform), transition: `transform ${ease}` }}>
          <img src={image.url} alt={`Slide ${index + 1}`} draggable={false} />
          {spotRegion && (
            <div
              className="spot"
              style={{
                left: `${(spotRegion.box.x - pad) * 100}%`,
                top: `${(spotRegion.box.y - pad) * 100}%`,
                width: `${(spotRegion.box.w + 2 * pad) * 100}%`,
                height: `${(spotRegion.box.h + 2 * pad) * 100}%`,
                boxShadow: `0 0 0 200vmax rgba(20, 20, 22, ${config.dimOpacity})`,
                opacity: zoomRegion ? 1 : 0,
                transition: `opacity ${ease}`,
              }}
            />
          )}
          {outlineRegion && (
            <div
              className="cue-outline"
              style={{
                left: `${(outlineRegion.box.x - pad) * 100}%`,
                top: `${(outlineRegion.box.y - pad) * 100}%`,
                width: `${(outlineRegion.box.w + 2 * pad) * 100}%`,
                height: `${(outlineRegion.box.h + 2 * pad) * 100}%`,
                opacity: activeRegion ? 1 : 0,
                transition: `opacity ${ease}`,
              }}
            />
          )}
          {outlines &&
            regions.map((r) => (
              <div
                key={r.id}
                className="spot debug-outline"
                style={{ left: `${r.box.x * 100}%`, top: `${r.box.y * 100}%`, width: `${r.box.w * 100}%`, height: `${r.box.h * 100}%` }}
              />
            ))}
        </div>
      </div>

      <div className="hud">
        <span>
          <i className={`dot ${auto ? "on" : ""}`} />
          {auto ? "Auto" : "Manual"}
        </span>
        <span>
          <i className={`dot ${mic.status === "listening" ? "listening" : mic.status === "error" || mic.status === "unsupported" ? "error" : ""}`} />
          {micLabel}
        </span>
      </div>
      {toast && (
        <div key={toast.id} className="voice-toast">
          {toast.text}
        </div>
      )}
      <div className="slide-no">
        {index + 1} / {deck.images.length}
      </div>

      <div className={`present-help ${helpVisible && !debug ? "" : "fade"}`}>
        <span className="kbd">←</span>
        <span className="kbd">→</span> slides <span className="kbd">Esc</span> zoom out <span className="kbd">A</span> auto{" "}
        <span className="kbd">D</span> debug
        <button className="btn small" onClick={() => onExit(index)}>
          Exit
        </button>
      </div>

      {debug && (
        <DebugPanel
          snap={snap}
          regions={regions}
          config={config}
          onConfig={setConfig}
          auto={auto}
          outlines={outlines}
          onOutlines={setOutlines}
          onSimulate={(text) => sim.push(text, true)}
          mic={mic}
          engine={engine}
          hasDeepgram={hasDeepgram}
          onEngine={setEngine}
          voiceCmds={voiceCmds}
          onVoiceCmds={setVoiceCmds}
          micLevel={micLevel}
          speechLog={speechLog}
          onClose={() => setDebug(false)}
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { beatScore, MAX_BEAT_CUES, MAX_DRY_RUNS, MAX_LESSONS, type Beat, type DryRun, type Matter, type Show, type ShowLimits, type ShowPatch } from "../../../shared/schema";
import { CueDirector, type CueBeat, type FlowState } from "../engine/cues";
import { api } from "../lib/api";
import { plural } from "../lib/format";
import { go } from "../lib/router";
import { frameUrl, useStage } from "../lib/stage";
import { DeepgramSpeechSource } from "../speech/DeepgramSpeechSource";
import type { SpeechResult, SpeechSource } from "../speech/SpeechSource";
import { WebSpeechSource } from "../speech/WebSpeechSource";
import { Loading, TopBar } from "./Chrome";

const SAVE_DEBOUNCE_MS = 600;
const MAX_LOG = 12;
const CUE_TICK_MS = 100;

const FLOW_LABEL: Record<FlowState, (next: string) => string> = {
  listening: (next) => `Listening for your first line: ${next}`,
  running: (next) => `Working on this step. Next: ${next}`,
  waiting: (next) => `Next: ${next}. It runs when you finish your thought.`,
  held: (next) => `Holding before ${next}. Say "go ahead" when you're ready.`,
  done: () => "That was the last step.",
};
/** Deepgram's limit on boosted terms, shared across the show. */
const MAX_KEYTERMS = 50;

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

function describeEvent(e: any): string | null {
  if (e.type === "action") return e.action;
  if (e.type === "blocked") return `Blocked: ${e.action}. ${e.reason}`;
  if (e.type === "replanned") return "The screen changed, so it will decide again when it hears the trigger";
  return null;
}

export default function ShowView({ id }: { id: string }) {
  const [show, setShow] = useState<Show | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeBeat, setActiveBeat] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [lastRun, setLastRun] = useState<DryRun | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [heard, setHeard] = useState("");
  const [nextCue, setNextCue] = useState<CueBeat | null>(null);
  const [flow, setFlow] = useState<FlowState>("listening");
  /** what the last dry run taught the demo, once the runner has worked it out */
  const [learned, setLearned] = useState<string | null>(null);
  const speech = useRef<SpeechSource | null>(null);
  const director = useRef<CueDirector | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<ShowPatch>({});

  // The project it's in, if any; a demo on its own lives in a hidden matter.
  const [project, setProject] = useState<Matter | null>(null);
  useEffect(() => {
    api.show(id).then(setShow).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);
  const matterId = show?.matterId;
  useEffect(() => {
    if (!matterId) return;
    api
      .matter(matterId)
      .then((d) => setProject(d.matter.solo ? null : d.matter))
      .catch(() => setProject(null));
  }, [matterId]);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length) await api.patchShow(id, patch).catch((e) => setError(e.message));
  }, [id]);

  /** Update now, save shortly. */
  const change = useCallback(
    (patch: ShowPatch) => {
      setShow((s) => (s ? { ...s, ...patch } : s));
      pending.current = { ...pending.current, ...patch };
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [flush],
  );
  useEffect(() => () => void flush(), [flush]);

  const showRef = useRef(show);
  showRef.current = show;

  const stage = useStage((msg) => {
    if (msg.type === "error") setError(msg.message);
    if (msg.type === "learned") {
      change({ beats: msg.beats, limits: msg.limits, recordingId: msg.recordingId, dryRuns: [] });
      setLastRun(null);
    }
    if (msg.type === "beat") setActiveBeat(msg.beatId);
    if (msg.type === "waiting") setWaiting(true);
    if (msg.type === "begun") setWaiting(false);
    if (msg.type === "cued") {
      director.current?.passed(msg.beatId);
      setNextCue(director.current?.next ?? null);
    }
    if (msg.type === "beat:done" && msg.outcome === "done") director.current?.done(msg.beatId, performance.now());
    if (msg.type === "agent") {
      const line = describeEvent(msg.event);
      if (line) setLog((l) => [...l.slice(-MAX_LOG + 1), line]);
    }
    if (msg.type === "improved" && msg.showId === showRef.current?.id) {
      const improvements = msg.improvements as { id: string; cues: string[]; lesson: string | null }[];
      const beats = showRef.current!.beats.map((b) => {
        const imp = improvements.find((i) => i.id === b.id);
        if (!imp) return b;
        const known = new Set(b.cues.map((c) => c.toLowerCase()));
        const cues = [...b.cues, ...imp.cues.filter((c) => !known.has(c.toLowerCase()))].slice(0, MAX_BEAT_CUES);
        const lessons = imp.lesson ? [...(b.lessons ?? []), imp.lesson].slice(-MAX_LESSONS) : b.lessons;
        return { ...b, cues, ...(lessons ? { lessons } : {}) };
      });
      change({ beats });
      const cues = improvements.reduce((n, i) => n + i.cues.length, 0);
      const lessons = improvements.filter((i) => i.lesson).length;
      setLearned([cues && plural(cues, "new trigger phrase"), lessons && plural(lessons, "lesson")].filter(Boolean).join(" and "));
    }
    if (msg.type === "dry-run:done") {
      setWaiting(false);
      setActiveBeat(null);
      setLastRun(msg.run);
      if (msg.run.results.length) change({ dryRuns: [...(showRef.current?.dryRuns ?? []), msg.run].slice(-MAX_DRY_RUNS) });
    }
  });

  const stopSpeech = () => {
    speech.current?.stop();
    speech.current = null;
    setHeard("");
  };
  useEffect(() => stopSpeech, []);

  const listen = async (onResult: (r: SpeechResult) => void, keyterms: string[] = []) => {
    const health = await fetch("/api/health").then((r) => r.json()).catch(() => ({}));
    const source: SpeechSource = health.hasDeepgram ? new DeepgramSpeechSource() : new WebSpeechSource();
    source.onResult(onResult);
    source.onStatus((status, detail) => status === "error" && setError(`Microphone: ${detail ?? "problem"}`));
    source.setKeyterms?.(keyterms);
    speech.current = source;
    source.start();
  };

  const startRecording = async () => {
    setError(null);
    await listen((r) => {
      const text = r.text.trim();
      if (r.isFinal && text) {
        stage.send({ type: "said", text, t: Date.now() });
        setHeard(text);
      }
    });
    stage.send({ type: "record:start", name: show?.name ?? "" });
  };

  const stopRecording = () => {
    stopSpeech();
    stage.send({ type: "record:stop" });
  };

  const startDryRun = async () => {
    await flush();
    setError(null);
    setLog([]);
    setLastRun(null);
    const beats = showRef.current?.beats ?? [];
    director.current = new CueDirector(beats);
    setNextCue(director.current.next);
    setLearned(null);
    await listen((r) => {
      director.current?.hear(r.text, r.isFinal, r.timestamp);
      if (r.text.trim()) setHeard(r.text.trim());
      // What was said goes to the runner too, so the run can teach the demo the presenter's own words.
      if (r.isFinal && r.text.trim()) stage.send({ type: "said", text: r.text.trim(), t: Date.now() });
    }, [...new Set(beats.flatMap((b) => b.cues))].slice(0, MAX_KEYTERMS));
    stage.send({ type: "dry-run", show: showRef.current });
  };

  const stageRef = useRef(stage);
  stageRef.current = stage;

  /** Words become cues only during a run, and the mic goes off with it. */
  useEffect(() => {
    if (stage.busy !== "dry-run") return;
    const timer = setInterval(() => {
      const beatId = director.current?.tick(performance.now());
      if (beatId) stageRef.current.send({ type: "cue", beatId });
      if (director.current) setFlow(director.current.state);
    }, CUE_TICK_MS);
    return () => {
      clearInterval(timer);
      stopSpeech();
      director.current = null;
      setNextCue(null);
    };
  }, [stage.busy]);

  const editBeat = (beat: Beat, patch: Partial<Beat>) => change({ beats: show!.beats.map((b) => (b.id === beat.id ? { ...b, ...patch } : b)) });
  const editLimit = (key: keyof ShowLimits, text: string) => change({ limits: { ...show!.limits, [key]: lines(text) } });

  const remove = async () => {
    if (!show || !confirm(`Delete “${show.name}”? This can't be undone. Its recording stays on this Mac.`)) return;
    clearTimeout(timer.current);
    pending.current = {};
    if (project) {
      await api.deleteShow(id);
      go(`/m/${show.matterId}`);
    } else {
      await api.deleteMatter(show.matterId);
      go("/demos");
    }
  };

  if (!show) {
    return (
      <>
        <TopBar tab="demos" back="/demos" />
        <main className="page">{error ? <div className="banner err">{error}</div> : <Loading />}</main>
      </>
    );
  }

  const { busy, connected, problem } = stage;
  const ready = connected && !busy && !problem;

  return (
    <>
      <TopBar tab="demos" back="/demos" crumbs={[...(project ? [{ label: project.name, to: `/m/${project.id}` }] : []), { label: show.name }]} />
      <main className="page">
        <div className="page-head">
          <div>
            <div className="micro">Demo · {show.beats.length ? plural(show.beats.length, "cue") : "not taught yet"}</div>
            <h1 className="display">{show.name}</h1>
          </div>
          <div className="page-actions">
            <button className="btn small ghost danger" onClick={remove}>
              Delete demo
            </button>
          </div>
        </div>

        {error && <div className="banner err">{error}</div>}
        {!connected && (
          <div className="banner">
            Looking for Stage on this Mac… It starts by itself when you log in and connects here on its own. If it never
            does, it isn't set up on this Mac yet: run <code>npm run stage:install</code> once.
          </div>
        )}
        {connected && problem && <div className="banner">{problem}</div>}

        <section className="section first">
          <div className="section-head">
            <h2 className="display">Teach</h2>
            <span className="hint">{stage.display ? `Stage display: ${stage.display}` : "Do the demo once while talking through it"}</span>
          </div>
          {busy === "recording" ? (
            <div className="stage-rec">
              <span className="stage-dot" />
              <div className="stage-rec-text">
                <strong>Recording your screen, clicks and voice</strong>
                <span className="hint">{heard || "Do the demo on the stage display. Password fields aren't recorded, but anything else on screen is."}</span>
              </div>
              <button className="btn primary" onClick={stopRecording}>
                Stop and learn
              </button>
            </div>
          ) : busy === "learning" ? (
            <div className="banner">Learning the demo. This can take a minute or two.</div>
          ) : (
            <div className="stage-actions">
              <button className="btn primary" disabled={!ready} onClick={startRecording}>
                {show.beats.length ? "Record again" : "Start recording"}
              </button>
              {show.beats.length > 0 && <span className="hint">Recording again replaces these cues and their scores.</span>}
            </div>
          )}
          <p className="hint stage-notice">
            Your voice goes to a speech service, and screenshots, what you type and what you say go to Claude so it can learn the demo. Known key and password formats are hidden from text, but screenshots are
            sent as they are, so use demo accounts and keep real secrets off this display.
          </p>
        </section>

        {show.beats.length > 0 && (
          <>
            <section className="section">
              <div className="section-head">
                <h2 className="display">Dry run</h2>
                <span className="hint">The AI performs the demo live on the stage display</span>
              </div>
              <div className="stage-actions">
                {busy === "dry-run" ? (
                  <>
                    {waiting && (
                      <button className="btn primary" onClick={() => stage.send({ type: "begin" })}>
                        Begin
                      </button>
                    )}
                    <button className="btn accent" onClick={() => stage.send({ type: "stop" })}>
                      Stop
                    </button>
                  </>
                ) : (
                  <button className="btn primary" disabled={!ready} onClick={startDryRun}>
                    Start dry run
                  </button>
                )}
                <span className="hint">
                  The screen goes black until you say your first line. After that it follows you: each step runs when you finish your thought or start on the next one. Say "hold on" to pause and "go ahead" to carry on. Space or Return moves on, and double Esc stops it from anywhere.
                </span>
              </div>
              {busy === "dry-run" && nextCue && (
                <div className="banner stage-cue">
                  <strong>{FLOW_LABEL[flow](nextCue.label)}</strong>
                  {flow === "listening" && <span className="hint">Say: {(nextCue.cues.length ? nextCue.cues : [nextCue.label]).slice(0, 3).join(", ")}</span>}
                  {heard && <span className="hint">Heard: {heard}</span>}
                </div>
              )}
              {log.length > 0 && busy === "dry-run" && <pre className="stage-log">{log.join("\n")}</pre>}
              {lastRun && (
                <div className="banner">
                  {lastRun.results.every((r) => r.outcome === "done") && lastRun.results.length === show.beats.length
                    ? "Every cue passed."
                    : `Stopped: ${lastRun.results.at(-1)?.summary ?? "no cues ran."}`}
                </div>
              )}
              {learned && <div className="banner">Learned from this run: {learned}. You'll find them in the cues below.</div>}
            </section>

            <section className="section">
              <div className="section-head">
                <h2 className="display">Cues</h2>
                <span className="hint">What the AI learned. Add corrections in Notes.</span>
              </div>
              <div className="stage-beats">
                {show.beats.map((b, i) => {
                  const score = beatScore(show.dryRuns, b.id);
                  return (
                    <article key={`${show.recordingId}-${b.id}`} className={`stage-beat ${activeBeat === b.id ? "active" : ""}`}>
                      <div className="stage-beat-head">
                        <span className="micro">Cue {i + 1}</span>
                        <input className="field" value={b.label} aria-label="Cue name" onChange={(e) => editBeat(b, { label: e.target.value })} />
                        <span className="hint">{score.total ? `${score.passed} of ${score.total} dry runs passed` : "No dry runs yet"}</span>
                      </div>
                      <label className="stage-field">
                        <span className="hint">Goal</span>
                        <textarea className="field" value={b.goal} onChange={(e) => editBeat(b, { goal: e.target.value })} />
                      </label>
                      <label className="stage-field">
                        <span className="hint">Done when</span>
                        <textarea className="field" value={b.success} onChange={(e) => editBeat(b, { success: e.target.value })} />
                      </label>
                      <label className="stage-field">
                        <span className="hint">Trigger words, one per line</span>
                        <textarea className="field" key={b.cues.join("\n")} defaultValue={b.cues.join("\n")} onBlur={(e) => editBeat(b, { cues: lines(e.target.value) })} />
                      </label>
                      <label className="stage-field">
                        <span className="hint">Notes for the AI</span>
                        <textarea className="field" value={b.notes} placeholder="Use the Acme account, not the test one" onChange={(e) => editBeat(b, { notes: e.target.value })} />
                      </label>
                      {(b.lessons?.length ?? 0) > 0 && (
                        <div className="stage-field">
                          <span className="hint">Learned from dry runs</span>
                          <ul className="stage-lessons">
                            {b.lessons!.map((l, n) => (
                              <li key={n}>
                                <span>{l}</span>
                                <button className="linkish" aria-label="Forget this lesson" onClick={() => editBeat(b, { lessons: b.lessons!.filter((_, k) => k !== n) })}>
                                  Forget
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {show.recordingId && b.landmarks.length > 0 && connected && (
                        <div className="stage-frames">
                          {b.landmarks.map((f) => {
                            const isCover = f === (show.cover ?? show.beats.flatMap((x) => x.landmarks).at(-1));
                            return (
                              <figure key={f} className={`stage-frame ${isCover ? "cover" : ""}`}>
                                <img src={frameUrl(show.recordingId!, f)} alt={`Reference screenshot for ${b.label}`} />
                                <button className="btn small" disabled={isCover} onClick={() => change({ cover: f })}>
                                  {isCover ? "Cover" : "Use as cover"}
                                </button>
                              </figure>
                            );
                          })}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>

            <section className="section">
              <div className="section-head">
                <h2 className="display">Limits</h2>
                <span className="hint">The AI can't act outside these. One per line.</span>
              </div>
              <div className="stage-limits">
                {(
                  [
                    ["apps", "Apps"],
                    ["origins", "Websites"],
                    ["commands", "Terminal commands it can run"],
                    ["actions", "Risky buttons it can press, such as Delete or Send"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="stage-field">
                    <span className="hint">{label}</span>
                    <textarea className="field" defaultValue={(show.limits[key] ?? []).join("\n")} key={show.recordingId} onBlur={(e) => editLimit(key, e.target.value)} />
                  </label>
                ))}
              </div>
            </section>
          </>
        )}
      </main>
    </>
  );
}

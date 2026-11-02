import { useCallback, useEffect, useRef, useState } from "react";
import { beatScore, MAX_DRY_RUNS, type Beat, type DryRun, type Show, type ShowLimits, type ShowPatch } from "../../../shared/schema";
import { api } from "../lib/api";
import { plural } from "../lib/format";
import { go } from "../lib/router";
import { frameUrl, useStage } from "../lib/stage";
import { DeepgramSpeechSource } from "../speech/DeepgramSpeechSource";
import type { SpeechSource } from "../speech/SpeechSource";
import { WebSpeechSource } from "../speech/WebSpeechSource";
import { Loading, TopBar } from "./Chrome";

const SAVE_DEBOUNCE_MS = 600;
const MAX_LOG = 12;

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

function describeEvent(e: any): string | null {
  if (e.type === "action") return e.action;
  if (e.type === "blocked") return `Blocked: ${e.action}. ${e.reason}`;
  if (e.type === "replanned") return "The screen changed, deciding again";
  return null;
}

export default function ShowView({ id }: { id: string }) {
  const [show, setShow] = useState<Show | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeBeat, setActiveBeat] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [approval, setApproval] = useState<{ id: string; question: string } | null>(null);
  const [lastRun, setLastRun] = useState<DryRun | null>(null);
  const [heard, setHeard] = useState("");
  const speech = useRef<SpeechSource | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<ShowPatch>({});

  useEffect(() => {
    api.show(id).then(setShow).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);

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
    if (msg.type === "approval") setApproval({ id: msg.id, question: msg.question });
    if (msg.type === "agent") {
      const line = describeEvent(msg.event);
      if (line) setLog((l) => [...l.slice(-MAX_LOG + 1), line]);
    }
    if (msg.type === "dry-run:done") {
      setActiveBeat(null);
      setApproval(null);
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

  const startRecording = async () => {
    setError(null);
    const health = await fetch("/api/health").then((r) => r.json()).catch(() => ({}));
    const source: SpeechSource = health.hasDeepgram ? new DeepgramSpeechSource() : new WebSpeechSource();
    source.onResult((r) => {
      const text = r.text.trim();
      if (r.isFinal && text) {
        stage.send({ type: "said", text, t: Date.now() });
        setHeard(text);
      }
    });
    source.onStatus((status, detail) => status === "error" && setError(`Microphone: ${detail ?? "problem"}`));
    speech.current = source;
    source.start();
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
    stage.send({ type: "dry-run", show: showRef.current });
  };

  const answer = (yes: boolean) => {
    if (approval) stage.send({ type: "approve", id: approval.id, yes });
    setApproval(null);
  };

  const editBeat = (beat: Beat, patch: Partial<Beat>) => change({ beats: show!.beats.map((b) => (b.id === beat.id ? { ...b, ...patch } : b)) });
  const editLimit = (key: keyof ShowLimits, text: string) => change({ limits: { ...show!.limits, [key]: lines(text) } });

  const remove = async () => {
    if (!show || !confirm(`Delete “${show.name}”? This can't be undone. Its recording stays on this Mac.`)) return;
    clearTimeout(timer.current);
    pending.current = {};
    await api.deleteShow(id);
    go(`/m/${show.matterId}`);
  };

  if (!show) {
    return (
      <>
        <TopBar crumbs={[{ label: "Matters", to: "/" }]} />
        <main className="page">{error ? <div className="banner err">{error}</div> : <Loading />}</main>
      </>
    );
  }

  const { busy, connected, paired } = stage;
  const ready = connected && !busy;

  return (
    <>
      <TopBar crumbs={[{ label: "Matters", to: "/" }, { label: "Matter", to: `/m/${show.matterId}` }, { label: show.name }]} />
      <main className="page">
        <div className="page-head">
          <div>
            <div className="micro">Show · {show.beats.length ? plural(show.beats.length, "beat") : "not taught yet"}</div>
            <h1 className="display">{show.name}</h1>
          </div>
          <div className="page-actions">
            <button className="btn small ghost danger" onClick={remove}>
              Delete show
            </button>
          </div>
        </div>

        {error && <div className="banner err">{error}</div>}
        {!paired && <div className="banner">Run <code>npm run stage</code> in Terminal and open the pairing link it prints.</div>}
        {paired && !connected && <div className="banner">Waiting for the Stage runner. Run <code>npm run stage</code> in Terminal.</div>}

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
                <span className="hint">{heard || "Do the demo on the stage display. Password fields aren't recorded."}</span>
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
              {show.beats.length > 0 && <span className="hint">Recording again replaces these beats and their scores.</span>}
            </div>
          )}
        </section>

        {show.beats.length > 0 && (
          <>
            <section className="section">
              <div className="section-head">
                <h2 className="display">Dry run</h2>
                <span className="hint">The AI performs the show live on the stage display</span>
              </div>
              <div className="stage-actions">
                {busy === "dry-run" ? (
                  <button className="btn accent" onClick={() => stage.send({ type: "stop" })}>
                    Stop
                  </button>
                ) : (
                  <button className="btn primary" disabled={!ready} onClick={startDryRun}>
                    Start dry run
                  </button>
                )}
                <span className="hint">Double Esc stops it from anywhere.</span>
              </div>
              {approval && (
                <div className="banner stage-approval">
                  <span>{approval.question}</span>
                  <button className="btn small primary" onClick={() => answer(true)}>
                    Allow (PageDown)
                  </button>
                  <button className="btn small" onClick={() => answer(false)}>
                    Refuse (PageUp)
                  </button>
                </div>
              )}
              {log.length > 0 && busy === "dry-run" && <pre className="stage-log">{log.join("\n")}</pre>}
              {lastRun && (
                <div className="banner">
                  {lastRun.results.every((r) => r.outcome === "done") && lastRun.results.length === show.beats.length
                    ? "Every beat passed."
                    : `Stopped: ${lastRun.results.at(-1)?.summary ?? "no beats ran."}`}
                </div>
              )}
            </section>

            <section className="section">
              <div className="section-head">
                <h2 className="display">Beats</h2>
                <span className="hint">What the AI learned. Add corrections in Notes.</span>
              </div>
              <div className="stage-beats">
                {show.beats.map((b, i) => {
                  const score = beatScore(show.dryRuns, b.id);
                  return (
                    <article key={`${show.recordingId}-${b.id}`} className={`stage-beat ${activeBeat === b.id ? "active" : ""}`}>
                      <div className="stage-beat-head">
                        <span className="micro">Beat {i + 1}</span>
                        <input className="field" value={b.label} aria-label="Beat name" onChange={(e) => editBeat(b, { label: e.target.value })} />
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
                        <span className="hint">Cue words, one per line</span>
                        <textarea className="field" defaultValue={b.cues.join("\n")} onBlur={(e) => editBeat(b, { cues: lines(e.target.value) })} />
                      </label>
                      <label className="stage-field">
                        <span className="hint">Notes for the AI</span>
                        <textarea className="field" value={b.notes} placeholder="Use the Acme account, not the test one" onChange={(e) => editBeat(b, { notes: e.target.value })} />
                      </label>
                      {show.recordingId && b.landmarks.length > 0 && connected && (
                        <div className="stage-frames">
                          {b.landmarks.map((f) => (
                            <img key={f} src={frameUrl(show.recordingId!, f)} alt={`Reference screenshot for ${b.label}`} />
                          ))}
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
                    ["commands", "Terminal commands it can run without asking"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="stage-field">
                    <span className="hint">{label}</span>
                    <textarea className="field" defaultValue={show.limits[key].join("\n")} key={show.recordingId} onBlur={(e) => editLimit(key, e.target.value)} />
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

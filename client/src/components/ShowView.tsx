import { useCallback, useEffect, useRef, useState } from "react";
import { applyShowChanges, applyVoice, describeChange, describeVoiceChange, MAX_HISTORY, type ChatTurn, type ShowChange, type ShowScript } from "../../../shared/rehearse";
import { beatScore, MAX_BEAT_CUES, MAX_DRY_RUNS, MAX_LESSONS, type Beat, type DryRun, type Matter, type Show, type ShowLimits, type ShowPatch } from "../../../shared/schema";
import { CueDirector, type CueBeat, type FlowState } from "../engine/cues";
import { api } from "../lib/api";
import { plural } from "../lib/format";
import { go } from "../lib/router";
import { frameUrl, useStage } from "../lib/stage";
import { DeepgramSpeechSource } from "../speech/DeepgramSpeechSource";
import type { SpeechResult, SpeechSource } from "../speech/SpeechSource";
import { WebSpeechSource } from "../speech/WebSpeechSource";
import { RobotSpeechSource, robotVoiceSupported } from "../speech/RobotSpeechSource";
import RehearsalChat, { type ChatMessage } from "./RehearsalChat";
import RobotVoiceControls, { tuneRobot, useRobotVoice } from "./RobotVoiceControls";
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
/** Lines of the rehearsal kept to send with feedback. */
const MAX_REHEARSE_LOG = 300;
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

  /* robot rehearsal: a robot talks the demo through while the operator performs it, and feedback in a chat tunes it */
  const [rehearsing, setRehearsing] = useState(false);
  const [script, setScript] = useState<ShowScript | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const robot = useRef<RobotSpeechSource | null>(null);
  /** true while the current dry run is the robot's */
  const robotRun = useRef(false);
  const robotOffs = useRef<(() => void)[]>([]);
  const rehearseLog = useRef<string[]>([]);
  /** start the robot's run again once the runner is free */
  const rerun = useRef(false);
  /** feedback is with Claude, so a run stopping now is expected */
  const awaitingCoach = useRef(false);
  const nextMsg = useRef(0);
  const scriptRef = useRef(script);
  scriptRef.current = script;
  const { voice, setVoice, voices } = useRobotVoice();
  useEffect(() => tuneRobot(robot.current, voice), [voice]);

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
    if (robotRun.current) robotHears(msg);
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

  /* ---------- robot rehearsal ---------- */
  const note = (role: ChatMessage["role"], text: string, extra: Partial<ChatMessage> = {}) =>
    setMessages((m) => [...m, { id: nextMsg.current++, role, text, ...extra }]);
  const logLine = (line: string) => {
    rehearseLog.current = [...rehearseLog.current, line].slice(-MAX_REHEARSE_LOG);
  };
  const beatName = (beatId: string) => {
    const at = showRef.current?.beats.findIndex((b) => b.id === beatId) ?? -1;
    return at < 0 ? beatId : `Cue ${at + 1}, "${showRef.current!.beats[at].label}"`;
  };
  const linesFor = (beatId: string | undefined) => scriptRef.current?.beats.find((b) => b.beatId === beatId)?.lines ?? [];

  /** What the runner tells the console, seen from the robot's side: when to talk, and what to remember for feedback. */
  function robotHears(msg: any) {
    const beats = showRef.current?.beats ?? [];
    // The screen is ready: open with the first beat's lines.
    if (msg.type === "waiting") void robot.current?.say(linesFor(beats[0]?.id));
    if (msg.type === "cued") {
      logLine(`${beatName(msg.beatId)} started`);
      // Talk about the next step while the operator works on this one, as a presenter would.
      const at = beats.findIndex((b) => b.id === msg.beatId);
      if (at >= 0 && beats[at + 1]) void robot.current?.say(linesFor(beats[at + 1].id));
    }
    if (msg.type === "agent") {
      const line = describeEvent(msg.event);
      if (line) logLine(`  operator: ${line}`);
    }
    if (msg.type === "beat:done") logLine(`${beatName(msg.beatId)} ${msg.outcome}`);
    if (msg.type === "dry-run:done") {
      robotRun.current = false;
      robot.current?.cancel();
      robotOffs.current.forEach((off) => off());
      robotOffs.current = [];
      const results: DryRun["results"] = msg.run.results;
      const all = beats.length > 0 && results.length === beats.length && results.every((r) => r.outcome === "done");
      if (!rerun.current && !awaitingCoach.current) note("note", all ? "Every cue passed. Tell me what to change, or run it again." : `Stopped: ${results.at(-1)?.summary ?? "no cues ran."} Tell me what went wrong.`);
    }
  }

  const openRehearsal = async () => {
    // Made on the click, so the browser lets it speak.
    robot.current ??= new RobotSpeechSource();
    tuneRobot(robot.current, voice);
    setRehearsing(true);
    setError(null);
    if (scriptRef.current) return;
    try {
      setScript(await api.showScript(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const startRobotRun = async () => {
    const r = robot.current;
    if (!r || !scriptRef.current) return;
    await flush();
    setError(null);
    setLog([]);
    setLastRun(null);
    setLearned(null);
    rehearseLog.current = [];
    const beats = showRef.current?.beats ?? [];
    director.current = new CueDirector(beats);
    setNextCue(director.current.next);
    robotOffs.current.forEach((off) => off());
    // The robot's words go to the cue director only. They're never sent to the runner as the presenter's, so
    // learning can't turn them into trigger words.
    robotOffs.current = [
      r.onResult((res) => {
        director.current?.hear(res.text, res.isFinal, res.timestamp);
        if (res.text.trim()) setHeard(res.text.trim());
        if (res.isFinal) logLine(`  robot said: "${res.text.trim()}"`);
      }),
    ];
    r.cancel();
    r.start();
    speech.current = r;
    robotRun.current = true;
    stage.send({ type: "dry-run", show: showRef.current });
  };

  // After feedback, run again as soon as the runner has stopped the last one.
  useEffect(() => {
    if (!rerun.current || stage.busy || !stage.connected) return;
    rerun.current = false;
    void startRobotRun();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage.busy, stage.connected, show]);

  const sendFeedback = async (feedback: string) => {
    const current = showRef.current;
    const s = scriptRef.current;
    if (!current || !s) return;
    const history: ChatTurn[] = messages
      .filter((m) => m.role !== "note")
      .map((m) => ({ role: m.role as ChatTurn["role"], text: m.text }))
      .slice(-MAX_HISTORY);
    note("presenter", feedback);
    const wasRunning = robotRun.current;
    awaitingCoach.current = true;
    robot.current?.cancel();
    if (wasRunning) stage.send({ type: "stop" });
    setThinking(true);
    try {
      const reply = await api.showFeedback(id, { feedback, history, log: rehearseLog.current, script: s, voice, voices });
      const before = { beats: current.beats, script: s };
      const out = applyShowChanges(before.beats, before.script, reply.changes);
      const newVoice = applyVoice(voice, reply.voice, voices);
      const voiceLine = describeVoiceChange(voice, newVoice);
      if (voiceLine) setVoice(newVoice);
      if (!out.applied.length) {
        // A voice change alone still runs it again, so they can hear it.
        if (voiceLine && wasRunning) rerun.current = true;
        note("coach", `${reply.reply}${voiceLine && wasRunning ? " Running it again from the start." : wasRunning ? " Press Start to run it again." : ""}`, voiceLine ? { changes: [voiceLine] } : {});
        return;
      }
      change({ beats: out.beats });
      setScript(out.script);
      const msgId = nextMsg.current;
      const undo = () => {
        change({ beats: before.beats });
        setScript(before.script);
        if (voiceLine) setVoice(voice);
        setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, undone: true } : x)));
        note("note", "Undone. Press Start to run it with the earlier version.");
      };
      setMessages((m) => m.map((x) => (x.undo ? { ...x, undo: undefined } : x)));
      note("coach", `${reply.reply} Running it again from the start.`, {
        changes: [...out.applied.map((c) => describeChange(c, (x) => beatName((x as ShowChange).beatId))), ...(voiceLine ? [voiceLine] : [])],
        undo,
      });
      rerun.current = true;
    } catch (e) {
      note("note", `Couldn't get that done: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      awaitingCoach.current = false;
      setThinking(false);
    }
  };

  const closeRehearsal = () => {
    if (robotRun.current) stage.send({ type: "stop" });
    robot.current?.cancel();
    rerun.current = false;
    setRehearsing(false);
  };
  useEffect(() => () => robot.current?.cancel(), []);

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
                  <>
                    <button className="btn primary" disabled={!ready} onClick={startDryRun}>
                      Start dry run
                    </button>
                    {robotVoiceSupported() && !rehearsing && (
                      <button className="btn" disabled={!ready} onClick={openRehearsal} title="A robot talks the demo through while the AI performs it, and you give feedback in a chat">
                        Rehearse with robot
                      </button>
                    )}
                  </>
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
              {rehearsing && (
                <div className="show-rehearse">
                  <div>
                    <div className="section-head">
                      <h3 className="micro">What the robot says before each cue</h3>
                    </div>
                    {!script ? (
                      <Loading text="Writing the script…" />
                    ) : (
                      <ol className="rehearse-lines">
                        {show.beats.map((b, i) => {
                          const text = script.beats.find((x) => x.beatId === b.id)?.lines.join("\n") ?? "";
                          return (
                            <li key={b.id}>
                              <span className="micro">
                                Cue {i + 1} · {b.label}
                              </span>
                              <textarea
                                className="field"
                                key={text}
                                defaultValue={text}
                                rows={2}
                                onBlur={(e) =>
                                  setScript({
                                    beats: show.beats.map((x) => (x.id === b.id ? { beatId: x.id, lines: lines(e.target.value) } : (script.beats.find((y) => y.beatId === x.id) ?? { beatId: x.id, lines: [] }))),
                                  })
                                }
                              />
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>
                  <RehearsalChat
                    status={
                      thinking
                        ? "Stopped while Claude reads your feedback"
                        : busy === "dry-run" && robotRun.current
                          ? "The robot is presenting and the AI is performing"
                          : script
                            ? "Ready. The robot speaks aloud; your mic stays off."
                            : "Writing the script…"
                    }
                    messages={messages}
                    thinking={thinking}
                    onSend={sendFeedback}
                    settings={<RobotVoiceControls voice={voice} voices={voices} onChange={setVoice} />}
                    placeholder="e.g. It opened the wrong account, or talk a bit faster"
                    actions={
                      <>
                        <button className="btn small primary" disabled={!ready || !script || thinking} onClick={startRobotRun}>
                          Start
                        </button>
                        <button className="btn small ghost" onClick={closeRehearsal}>
                          Close
                        </button>
                      </>
                    }
                  />
                </div>
              )}
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

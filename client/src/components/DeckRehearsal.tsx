import { useEffect, useRef, useState } from "react";
import { applyDeckChanges, applyVoice, staleHighlights, describeChange, describeVoiceChange, MAX_HISTORY, type ChatTurn, type DeckChange, type DeckScript } from "../../../shared/rehearse";
import type { RunEvent, RunInput, Slide } from "../../../shared/schema";
import { api } from "../lib/api";
import type { Deck } from "../lib/deck";
import { deckTitle, plural } from "../lib/format";
import { RobotSpeechSource, robotVoiceSupported } from "../speech/RobotSpeechSource";
import { highlightMarks } from "../lib/textLines";
import { Loading, TopBar } from "./Chrome";
import PresentView from "./PresentView";
import RehearsalChat, { type ChatMessage } from "./RehearsalChat";
import RobotVoiceControls, { tuneRobot, useRobotVoice } from "./RobotVoiceControls";

/** The robot's words go in the run log as simulated, so this many is plenty to judge the feedback by. */
const MAX_EVENTS_SENT = 1500;

interface Props {
  deckId: string;
  deck: Deck;
  startIndex: number;
  /** kept by the page, so a second rehearsal doesn't pay for a new script */
  script: DeckScript | null;
  onScript: (script: DeckScript) => void;
  /** the coach's edits, saved like any other edit to the deck */
  onSlides: (slides: Slide[]) => void;
  onRunEnd: (run: Omit<RunInput, "deckId">, unloading: boolean) => void;
  onExit: (index: number) => void;
}

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

/** A robot talks through the deck while the presenter watches, and their feedback tunes the cues between runs. */
export default function DeckRehearsal({ deckId, deck, startIndex, script, onScript, onSlides, onRunEnd, onExit }: Props) {
  const [phase, setPhase] = useState<"script" | "running">("script");
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState(startIndex);
  /** bumped to start the run again with the latest cues */
  const [runKey, setRunKey] = useState(0);
  const [paused, setPaused] = useState(false);
  const [slide, setSlide] = useState(startIndex);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const robot = useRef<RobotSpeechSource | null>(null);
  const events = useRef<RunEvent[]>([]);
  const nextId = useRef(0);
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const scriptRef = useRef(script);
  scriptRef.current = script;
  const { voice, setVoice, voices } = useRobotVoice();
  useEffect(() => tuneRobot(robot.current, voice), [voice]);
  const voiceControls = <RobotVoiceControls voice={voice} voices={voices} onChange={setVoice} />;

  const write = async (fresh = false) => {
    setError(null);
    try {
      if (!fresh && scriptRef.current) return;
      const notes = deck.images.some((img) => img.facts?.notes) ? deck.images.map((img) => img.facts?.notes ?? "") : undefined;
      onScript(await api.deckScript(deckId, notes));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void write();
    // once, on opening
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => robot.current?.cancel(), []);

  const say = (role: ChatMessage["role"], text: string, extra: Partial<ChatMessage> = {}) =>
    setMessages((m) => [...m, { id: nextId.current++, role, text, ...extra }]);

  const start = () => {
    // Created on the click, so the browser lets it speak.
    robot.current ??= new RobotSpeechSource();
    tuneRobot(robot.current, voice);
    setPhase("running");
    setPaused(false);
    say("note", "The robot is presenting. Watch the cues, and write here whenever something should change. Writing pauses it.");
  };

  const restart = (at: number) => {
    setFrom(at);
    setSlide(at);
    setRunKey((k) => k + 1);
    setPaused(false);
  };

  const regionName = (c: DeckChange) => {
    if (!("regionId" in c)) return `Slide ${c.slide}`;
    const label = deckRef.current.slides.find((s) => s.index === c.slide - 1)?.regions.find((r) => r.id === c.regionId)?.label;
    return `Slide ${c.slide}, ${label ? `"${label}"` : c.regionId}`;
  };

  const send = async (feedback: string) => {
    const s = scriptRef.current;
    if (!s) return;
    const history: ChatTurn[] = messages
      .filter((m) => m.role !== "note")
      .map((m) => ({ role: m.role as ChatTurn["role"], text: m.text }))
      .slice(-MAX_HISTORY);
    say("presenter", feedback);
    setPaused(true);
    setThinking(true);
    try {
      const reply = await api.deckFeedback(deckId, { feedback, history, events: events.current.slice(-MAX_EVENTS_SENT), slide, script: s, voice, voices });
      const before = { slides: deckRef.current.slides, script: s };
      const out = applyDeckChanges(before.slides, before.script, reply.changes);
      const names = out.applied.map((c) => describeChange(c, (x) => regionName(x as DeckChange)));
      // A new voice is heard from the robot's next line; it doesn't need the run to start again.
      const newVoice = applyVoice(voice, reply.voice, voices);
      const voiceLine = describeVoiceChange(voice, newVoice);
      if (voiceLine) setVoice(newVoice);
      if (!out.applied.length) {
        say("coach", reply.reply, voiceLine ? { changes: [voiceLine] } : {});
        setPaused(false);
        return;
      }
      if (voiceLine) names.push(voiceLine);
      onSlides(out.slides);
      onScript(out.script);
      // A cue switched to Highlight needs its marker lines, which are read from the slide.
      let marked = out.slides;
      for (const { slide: at, regionId } of staleHighlights(before.slides, out.slides)) {
        const r = marked.find((x) => x.index === at)?.regions.find((x) => x.id === regionId);
        const marks = r && deck.images[at] ? await highlightMarks(deck.images[at], r.box).catch(() => undefined) : undefined;
        if (marks) marked = marked.map((x) => (x.index === at ? { ...x, regions: x.regions.map((y) => (y.id === regionId ? { ...y, marks } : y)) } : x));
      }
      if (marked !== out.slides) onSlides(marked);
      const id = nextId.current;
      const undo = () => {
        onSlides(before.slides);
        onScript(before.script);
        if (voiceLine) setVoice(voice);
        setMessages((m) => m.map((x) => (x.id === id ? { ...x, undone: true } : x)));
        say("note", `Undone. Starting again from slide ${reply.rerunFrom}.`);
        restart(reply.rerunFrom - 1);
      };
      // Only the latest change can be undone; undoing an older one would also throw away the ones after it.
      setMessages((m) => m.map((x) => (x.undo ? { ...x, undo: undefined } : x)));
      say("coach", `${reply.reply} Starting again from slide ${reply.rerunFrom}.`, { changes: names, undo });
      restart(reply.rerunFrom - 1);
    } catch (e) {
      say("note", `Couldn't get that done: ${e instanceof Error ? e.message : String(e)} Press Resume to carry on.`);
    } finally {
      setThinking(false);
    }
  };

  if (!robotVoiceSupported()) {
    return (
      <main className="page">
        <div className="banner err">This browser can't speak, so the robot can't present. Use Chrome or Safari.</div>
        <button className="btn" onClick={() => onExit(startIndex)}>
          Back
        </button>
      </main>
    );
  }

  if (phase === "script") {
    return (
      <>
      <TopBar tab="decks" crumbs={[{ label: deckTitle(deck.name) }, { label: "Rehearse" }]} />
      <main className="page rehearse-script">
        <div className="page-head">
          <div>
            <div className="micro">Robot rehearsal</div>
            <h1 className="display">What the robot will say</h1>
          </div>
          <div className="page-actions">
            <button className="btn small ghost" onClick={() => onExit(startIndex)}>
              Back
            </button>
            <button className="btn small" disabled={!script} onClick={() => void write(true)}>
              Write a new script
            </button>
            <button className="btn small primary" disabled={!script} onClick={start}>
              Start from slide {startIndex + 1}
            </button>
          </div>
        </div>
        {voiceControls}
        <p className="hint">
          Claude wrote this the way a presenter would say it, mostly not in your cues' exact words, to test how well Stage follows real speech. Edit any line. The robot speaks
          aloud, moves the slides itself and keeps your mic off.
        </p>
        {error && <div className="banner err">{error}</div>}
        {!script && !error && <Loading text="Writing the script…" />}
        {script && (
          <ol className="rehearse-lines">
            {deck.images.map((_, i) => {
              const entry = script.slides.find((s) => s.slide === i + 1);
              const text = entry?.lines.join("\n") ?? "";
              return (
                <li key={i} className={i < startIndex ? "skipped" : ""}>
                  <span className="micro">
                    Slide {i + 1} · {plural(deck.slides[i]?.regions.length ?? 0, "cue")}
                  </span>
                  <textarea
                    className="field"
                    key={text}
                    defaultValue={text}
                    rows={Math.max(2, entry?.lines.length ?? 1)}
                    onBlur={(e) =>
                      onScript({ slides: [...script.slides.filter((s) => s.slide !== i + 1), { slide: i + 1, lines: lines(e.target.value) }].sort((a, b) => a.slide - b.slide) })
                    }
                  />
                </li>
              );
            })}
          </ol>
        )}
      </main>
      </>
    );
  }

  const status = thinking
    ? "Paused while Claude reads your feedback"
    : paused
      ? `Paused on slide ${slide + 1}`
      : `Presenting slide ${slide + 1} of ${deck.images.length}`;

  return (
    <div className="rehearse-layout">
      <PresentView
        key={runKey}
        deck={deck}
        startIndex={from}
        onRunEnd={onRunEnd}
        onExit={onExit}
        rehearsal={{
          robot: robot.current!,
          script: script!,
          paused: paused || thinking,
          eventsRef: events,
          onSlide: setSlide,
          onFinished: () => {
            setPaused(true);
            say("note", "That was the last slide. Tell me what to change, or start over.");
          },
        }}
      />
      <RehearsalChat
        status={status}
        messages={messages}
        thinking={thinking}
        onSend={send}
        settings={voiceControls}
        placeholder="e.g. Slow down a little, or suggest better cues for this slide"
        actions={
          <>
            <button className="btn small" disabled={thinking} onClick={() => setPaused((p) => !p)}>
              {paused ? "Resume" : "Pause"}
            </button>
            <button className="btn small" disabled={thinking} onClick={() => restart(0)}>
              Start over
            </button>
            <button className="btn small ghost" onClick={() => onExit(slide)}>
              Done
            </button>
          </>
        }
      />
    </div>
  );
}

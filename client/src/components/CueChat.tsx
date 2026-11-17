import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { applyDeckChanges, describeChange, MAX_HISTORY, staleHighlights, type ChatTurn, type DeckChange } from "../../../shared/rehearse";
import type { Region, Slide } from "../../../shared/schema";
import { api } from "../lib/api";
import { slideImage, type Deck } from "../lib/deck";
import { plural } from "../lib/format";
import { highlightMarks } from "../lib/textLines";
import RehearsalChat, { type ChatMessage } from "./RehearsalChat";

interface Props {
  deckId: string;
  deck: Deck;
  /** the slide on screen, from 0 */
  index: number;
  /** always the latest slides, since answers arrive after the editor may have moved on */
  slides: MutableRefObject<Slide[]>;
  onRegions: (index: number, regions: Region[]) => void;
}

const WELCOME =
  'Tell me how the cues on this slide should work. For example: "Add a spotlight on the 61% box", "Make the Q4 bar a highlight and fire it last", "The chart cue fires too early" or "Suggest better cues for this slide".';

/**
 * A chat in the slide editor: say how the cues should work, and Claude, looking at the slide, makes the edits. It waits
 * as a button in the bottom-left of the slide area and slides in as a panel on the right. Closing only slides it away,
 * so the conversation and any answer on its way are kept.
 */
export default function CueChat({ deckId, deck, index, slides, onRegions }: Props) {
  const [open, setOpen] = useState(false);
  /** an answer came while the chat was hidden */
  const [unread, setUnread] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!open) return;
    setUnread(false);
    input.current?.focus();
  }, [open]);
  const [messages, setMessages] = useState<ChatMessage[]>([{ id: 0, role: "note", text: WELCOME }]);
  const [thinking, setThinking] = useState(false);
  const nextId = useRef(1);

  const say = (role: ChatMessage["role"], text: string, extra: Partial<ChatMessage> = {}) => {
    setMessages((m) => [...m, { id: nextId.current++, role, text, ...extra }]);
    if (role !== "presenter" && !openRef.current) setUnread(true);
  };

  /** Saves every slide whose cues changed. */
  const save = (next: Slide[], before: Slide[]) => {
    for (const s of next) {
      const old = before.find((b) => b.index === s.index);
      if (old?.regions !== s.regions) onRegions(s.index, s.regions);
    }
  };

  /** Highlight cues draw over each line of text in their box, which is read from the slide here, not by Claude. */
  const refreshHighlights = async (before: Slide[], after: Slide[]) => {
    for (const { slide, regionId } of staleHighlights(before, after)) {
      const r = after.find((s) => s.index === slide)?.regions.find((x) => x.id === regionId);
      if (!r || !deck.images[slide]) continue;
      const marks = await highlightMarks(deck.images[slide], r.box).catch(() => undefined);
      if (!marks) continue;
      const current = slides.current[slide]?.regions ?? [];
      onRegions(slide, current.map((x) => (x.id === regionId ? { ...x, marks } : x)));
    }
  };

  const send = async (message: string) => {
    const history: ChatTurn[] = messages
      .filter((m) => m.role !== "note")
      .map((m) => ({ role: m.role as ChatTurn["role"], text: m.text }))
      .slice(-MAX_HISTORY);
    say("presenter", message);
    setThinking(true);
    const at = index;
    try {
      const img = deck.images[at];
      const reply = await api.cueChat(deckId, {
        message,
        history,
        slide: at,
        image: await slideImage(img),
        facts: img.facts,
        regions: slides.current[at]?.regions ?? [],
      });
      const before = slides.current;
      const out = applyDeckChanges(before, { slides: [] }, reply.changes);
      if (!out.applied.length) return say("coach", reply.reply);
      save(out.slides, before);
      void refreshHighlights(before, out.slides);
      const name = (c: DeckChange) => {
        if (!("regionId" in c)) return `Slide ${c.slide}`;
        const label = before.find((s) => s.index === c.slide - 1)?.regions.find((r) => r.id === c.regionId)?.label;
        return `Slide ${c.slide}, ${label ? `"${label}"` : c.regionId}`;
      };
      const id = nextId.current;
      const undo = () => {
        save(before, slides.current);
        setMessages((m) => m.map((x) => (x.id === id ? { ...x, undone: true } : x)));
      };
      // Only the latest change can be undone; undoing an older one would also throw away the ones after it.
      setMessages((m) => m.map((x) => (x.undo ? { ...x, undo: undefined } : x)));
      say("coach", reply.reply, { changes: out.applied.map((c) => describeChange(c, (x) => name(x as DeckChange))), undo });
    } catch (e) {
      say("note", `Couldn't do that: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setThinking(false);
    }
  };

  const count = deck.slides[index]?.regions.length ?? 0;
  return (
    <>
      {/* The editor's third column: it slides in from the right and the slide makes room, so the slide list stays in view. */}
      <div className={`cue-chat-dock ${open ? "open" : ""}`} inert={!open}>
        <div className="cue-chat-dock-inner">
          <RehearsalChat
            title="Chat"
            status={thinking ? "Looking at the slide…" : `Slide ${index + 1} · ${plural(count, "cue")}`}
            messages={messages}
            thinking={thinking}
            onSend={send}
            inputRef={input}
            onEscape={() => setOpen(false)}
            placeholder="e.g. Spotlight the 61% box when I talk about margin"
            actions={
              <button className="cue-chat-close" aria-label="Hide chat" title="Hide chat (Esc)" onClick={() => setOpen(false)}>
                <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                  <path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            }
          />
        </div>
      </div>
      {!open && (
        <button className="cue-chat-launcher" aria-label="Open chat" title="Tell Claude how the cues on this slide should work" onClick={() => setOpen(true)}>
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
            <path
              d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3H4A1.5 1.5 0 0 1 2.5 13V6A1.5 1.5 0 0 1 4 4.5z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
          <span>Chat</span>
          {unread && <i className="cue-chat-dot" aria-label="New reply" />}
          {thinking && <i className="cue-chat-busy" aria-hidden="true" />}
        </button>
      )}
    </>
  );
}

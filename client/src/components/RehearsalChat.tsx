import { useEffect, useRef, useState, type ReactNode } from "react";

export interface ChatMessage {
  id: number;
  role: "presenter" | "coach" | "note";
  text: string;
  /** what the coach changed, one line each */
  changes?: string[];
  undo?: () => void;
  undone?: boolean;
}

interface Props {
  /** small heading above the status */
  title?: string;
  /** one line on what the robot is doing */
  status: string;
  messages: ChatMessage[];
  /** Claude is working on the last message */
  thinking: boolean;
  onSend: (text: string) => void;
  /** Pause, restart and so on */
  actions?: ReactNode;
  /** how the robot sounds */
  settings?: ReactNode;
  placeholder?: string;
  /** Esc in the message box */
  onEscape?: () => void;
  /** a ref to the message box, to focus it */
  inputRef?: React.Ref<HTMLTextAreaElement>;
}

/** The feedback chat beside a robot rehearsal. Writing pauses the robot; the coach's edits apply and it runs again. */
export default function RehearsalChat({ title = "Robot rehearsal", status, messages, thinking, onSend, actions, settings, placeholder, onEscape, inputRef }: Props) {
  const [draft, setDraft] = useState("");
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, thinking]);

  const send = () => {
    const text = draft.trim();
    if (!text || thinking) return;
    setDraft("");
    onSend(text);
  };

  return (
    <aside className="rehearse-chat" aria-label={title}>
      <header className="rehearse-chat-head">
        <div>
          <div className="micro">{title}</div>
          <div className="rehearse-status">{status}</div>
        </div>
        {actions && <div className="rehearse-actions">{actions}</div>}
        {settings}
      </header>
      <div className="rehearse-messages" ref={list}>
        {messages.map((m) => (
          <div key={m.id} className={`rehearse-msg ${m.role} ${m.undone ? "undone" : ""}`}>
            <p>{m.text}</p>
            {m.changes && m.changes.length > 0 && (
              <ul className="rehearse-changes">
                {m.changes.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            )}
            {m.undo && (
              <button className="linkish" disabled={m.undone} onClick={m.undo}>
                {m.undone ? "Undone" : "Undo"}
              </button>
            )}
          </div>
        ))}
        {thinking && <div className="rehearse-msg coach thinking">Working on it…</div>}
      </div>
      <form
        className="rehearse-compose"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          ref={inputRef}
          className="field"
          rows={2}
          value={draft}
          placeholder={placeholder ?? "What should it do differently?"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Keys typed here are feedback, never shortcuts for the presenter view behind it.
            e.stopPropagation();
            if (e.key === "Escape") onEscape?.();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn small primary" type="submit" disabled={!draft.trim() || thinking}>
          Send
        </button>
      </form>
    </aside>
  );
}

import { useEffect, useRef, useState, type ReactNode } from "react";

export interface Crumb {
  label: string;
  to?: string;
}

export type Tab = "projects" | "decks" | "demos";

const TABS: [Tab, string, string][] = [
  ["projects", "Projects", "#/projects"],
  ["decks", "Decks", "#/"],
  ["demos", "Demos", "#/demos"],
];

/** The brand and where you are, then the Projects, Decks and Demos tabs. */
export function TopBar({ tab, crumbs = [], children }: { tab?: Tab; crumbs?: Crumb[]; children?: ReactNode }) {
  return (
    <header className="topbar">
      <a className="brand" href="#/">
        Stage<span className="brand-dot">.</span>
      </a>
      {crumbs.length > 0 && (
        <nav className="crumbs">
          {crumbs.map((c, i) => (
            <span key={i} className="crumb">
              {c.to ? <a href={`#${c.to}`}>{c.label}</a> : <span>{c.label}</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="spacer" />
      <nav className="tabs" aria-label="Products">
        {TABS.map(([t, label, href]) => (
          <a key={t} href={href} aria-current={tab === t ? "page" : undefined}>
            {label}
          </a>
        ))}
      </nav>
      {children}
    </header>
  );
}

/** Small modal asking for one name. */
export function NameDialog({
  title,
  label,
  initial = "",
  submitLabel,
  children,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial?: string;
  submitLabel: string;
  children?: ReactNode;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.select();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setBusy(true);
          try {
            await onSubmit(name.trim());
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setBusy(false);
          }
        }}
      >
        <h3 className="display">{title}</h3>
        <label>
          <span className="micro">{label}</span>
          <input ref={input} className="field" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        {children}
        {error && <div className="banner err">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim() || busy}>
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

export function Loading({ text = "Loading…" }: { text?: string }) {
  return <div className="page-status micro">{text}</div>;
}

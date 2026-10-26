import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RunSummary } from "../../../shared/schema";
import { api } from "../lib/api";
import { dateTime, duration, relTime } from "../lib/format";
import { go } from "../lib/router";

export interface Crumb {
  label: string;
  to?: string;
}

export function TopBar({ crumbs = [], children }: { crumbs?: Crumb[]; children?: ReactNode }) {
  return (
    <header className="topbar">
      <a className="brand" href="#/">
        Producer<span className="brand-dot">.</span>
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
      {children}
    </header>
  );
}

export function RunList({ runs, showMatter, empty }: { runs: RunSummary[]; showMatter?: boolean; empty: ReactNode }) {
  if (runs.length === 0) return <div className="empty-row">{empty}</div>;
  return (
    <div className="runs" role="table">
      <div className="run-row head" role="row">
        <span>When</span>
        <span>Presentation</span>
        <span className="num">Length</span>
        <span className="num">Slides</span>
        <span className="num">Zooms</span>
      </div>
      {runs.map((r) => (
        <a key={r.id} className="run-row" role="row" href={`#/r/${r.id}`}>
          <span title={dateTime(r.startedAt)}>{relTime(r.startedAt)}</span>
          <span className="run-name">
            {r.deckName.replace(/\.pdf$/i, "")}
            {showMatter && <span className="hint"> · {r.matterName}</span>}
          </span>
          <span className="num">{duration(r.stats.durationMs)}</span>
          <span className="num">
            {r.stats.slidesVisited}/{r.slideCount}
          </span>
          <span className="num">{r.stats.zooms}</span>
        </a>
      ))}
    </div>
  );
}

/** Small modal asking for one name. */
export function NameDialog({
  title,
  label,
  initial = "",
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial?: string;
  submitLabel: string;
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

export function NewMatterButton({ className, children }: { className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={className} onClick={() => setOpen(true)}>
        {children}
      </button>
      {open && (
        <NameDialog
          title="New matter"
          label="Name"
          submitLabel="Create matter"
          onClose={() => setOpen(false)}
          onSubmit={async (name) => {
            const m = await api.createMatter(name);
            go(`/m/${m.id}`);
          }}
        />
      )}
    </>
  );
}

export function Loading({ text = "Loading…" }: { text?: string }) {
  return <div className="page-status micro">{text}</div>;
}

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { back as goBack } from "../lib/router";

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
export function TopBar({ tab, back, crumbs = [], children }: { tab?: Tab; back?: string; crumbs?: Crumb[]; children?: ReactNode }) {
  const tabsRef = useThumb<HTMLElement>('[aria-current="page"]', tab);
  return (
    <header className="topbar">
      <a className="brand" href="#/">
        Stage<span className="brand-dot">.</span>
      </a>
      {back && <BackButton to={back} />}
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
      <nav className="tabs" aria-label="Products" ref={tabsRef}>
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

/** Returns to the previous page, or to `to` when this page was opened directly. */
export function BackButton({ to }: { to: string }) {
  return (
    <button className="back" onClick={() => goBack(to)}>
      <span aria-hidden="true">←</span> Back
    </button>
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

/**
 * Keeps a sliding pill under the chosen child of a tray: sets --thumb-x and --thumb-w on the
 * container to the chosen child's box, and marks it ready after the first placement so the
 * pill glides between choices instead of flying in from the edge on first paint.
 */
export function useThumb<T extends HTMLElement>(selector: string, chosen: unknown) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const on = el.querySelector<HTMLElement>(selector);
      el.style.setProperty("--thumb-x", `${on ? on.offsetLeft : 0}px`);
      el.style.setProperty("--thumb-w", `${on ? on.offsetWidth : 0}px`);
      el.style.setProperty("--thumb-o", on ? "1" : "0");
    };
    place();
    const ready = requestAnimationFrame(() => (el.dataset.ready = ""));
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(ready);
      ro.disconnect();
    };
  }, [selector, chosen]);
  return ref;
}

export interface Option<V extends string> {
  value: V;
  label: string;
}

/** A styled stand-in for <select>: a field-like button that opens a list of choices. */
export function Select<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: Option<V>[];
  onChange: (value: V) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const chosen = Math.max(0, options.findIndex((o) => o.value === value));

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);

  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const show = () => {
    setActive(chosen);
    setOpen(true);
  };
  const pick = (i: number) => {
    onChange(options[i].value);
    setOpen(false);
  };

  return (
    <div className="select" ref={box}>
      <span className="micro" id={`${id}-label`}>
        {label}
      </span>
      <button
        type="button"
        className="field select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label ${id}-value`}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        aria-controls={open ? `${id}-list` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          const step = (d: number) => setActive((i) => Math.min(options.length - 1, Math.max(0, i + d)));
          if (!open) {
            if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
              e.preventDefault();
              show();
            }
            return;
          }
          if (e.key === "ArrowDown") step(1);
          else if (e.key === "ArrowUp") step(-1);
          else if (e.key === "Home") setActive(0);
          else if (e.key === "End") setActive(options.length - 1);
          else if (e.key === "Enter" || e.key === " ") pick(active);
          else if (e.key === "Escape") setOpen(false);
          else if (e.key === "Tab") return setOpen(false);
          else if (e.key.length === 1) {
            const at = options.findIndex((o) => o.label.toLowerCase().startsWith(e.key.toLowerCase()));
            if (at >= 0) setActive(at);
          } else return;
          // Keep keys that drive the list from reaching the dialog (Escape would close it).
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <span id={`${id}-value`} className="select-value">
          {options[chosen]?.label}
        </span>
        <svg className="select-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul className="select-list" role="listbox" id={`${id}-list`} ref={list} aria-labelledby={`${id}-label`}>
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === chosen}
              className={i === active ? "active" : undefined}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A styled stand-in for confirm(): asks once, shows any error, and closes on Escape or Cancel. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-label={title}>
        <h3 className="display">{title}</h3>
        {children && <p className="dialog-text">{children}</p>}
        {error && <div className="banner err">{error}</div>}
        <div className="dialog-actions">
          {/* Cancel takes focus, so Return never deletes by accident. */}
          <button type="button" className="btn ghost" onClick={onClose} autoFocus>
            Cancel
          </button>
          <button
            type="button"
            className="btn danger-fill"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Loading({ text = "Loading…" }: { text?: string }) {
  return <div className="page-status micro">{text}</div>;
}

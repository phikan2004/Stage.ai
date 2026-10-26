const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function relTime(ts: number, now = Date.now()): string {
  const d = now - ts;
  if (d < MIN) return "Just now";
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY && new Date(ts).getDate() === new Date(now).getDate()) return `${Math.floor(d / HOUR)} h ago`;
  if (d < 2 * DAY && new Date(now - DAY).getDate() === new Date(ts).getDate()) return "Yesterday";
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
}

export const dateTime = (ts: number) =>
  new Date(ts).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** 0:42, 12:05, 1:04:09 */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** 45 s, 12 min, 1 h 4 min */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

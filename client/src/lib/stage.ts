import { useEffect, useRef, useState } from "react";

const TOKEN_KEY = "producer.stageToken";
const RUNNER = "127.0.0.1:8788";
const RETRY_MS = 2000;

function saveStageToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore */
  }
}

function stageToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export const frameUrl = (recordingId: string, file: string) => `http://${RUNNER}/frames/${recordingId}/${file}?token=${stageToken()}`;

/** A demo's cover: the frame chosen for it, else the last key moment it learned. Served by the runner on this Mac, so null when it isn't paired here. */
export function coverUrl(show: { recordingId: string | null; cover: string | null; beats: { landmarks: string[] }[] }): string | null {
  const frame = show.cover ?? show.beats.flatMap((b) => b.landmarks).at(-1);
  return show.recordingId && frame && stageToken() ? frameUrl(show.recordingId, frame) : null;
}

export type Busy = "recording" | "learning" | "dry-run" | null;

export interface StageState {
  /** Connected to the runner on this Mac. */
  connected: boolean;
  busy: Busy;
  display: string | null;
  /** What the runner is waiting on before it can work (a permission, a second display), if anything. */
  problem: string | null;
}

/** Asks the runner for its pairing token. It only answers the Stage console's own origin. */
async function pair(): Promise<string | null> {
  try {
    const res = await fetch(`http://${RUNNER}/pair`, { cache: "no-store" });
    if (!res.ok) return null;
    const { token } = (await res.json()) as { token: string };
    saveStageToken(token);
    return token;
  } catch {
    return null;
  }
}

/** The link to the runner on this Mac. Pairs and reconnects by itself, so the runner can start before or after the page. */
export function useStage(onMessage: (msg: any) => void) {
  const handler = useRef(onMessage);
  handler.current = onMessage;
  const socket = useRef<WebSocket | null>(null);
  const [state, setState] = useState<StageState>({ connected: false, busy: null, display: null, problem: null });

  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout>;
    const later = () => {
      if (alive) retry = setTimeout(connect, RETRY_MS);
    };
    const connect = async () => {
      const token = await pair();
      if (!alive) return;
      if (!token) return later();
      const ws = new WebSocket(`ws://${RUNNER}/?token=${token}`);
      socket.current = ws;
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "status") setState({ connected: true, busy: msg.busy, display: msg.display, problem: msg.problem ?? null });
        else handler.current(msg);
      };
      ws.onclose = () => {
        if (!alive) return;
        setState((s) => ({ ...s, connected: false, busy: null }));
        later();
      };
    };
    connect();
    return () => {
      alive = false;
      clearTimeout(retry);
      socket.current?.close();
    };
  }, []);

  const send = (msg: unknown) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(msg));
  };
  return { ...state, send };
}

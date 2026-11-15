import { useEffect, useRef, useState } from "react";

const TOKEN_KEY = "producer.stageToken";
const RUNNER = "127.0.0.1:8788";
const RETRY_MS = 2000;

export function saveStageToken(token: string): void {
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
  paired: boolean;
  connected: boolean;
  busy: Busy;
  display: string | null;
}

/** The link to the runner on this Mac. Reconnects by itself, so the runner can start after the page does. */
export function useStage(onMessage: (msg: any) => void) {
  const handler = useRef(onMessage);
  handler.current = onMessage;
  const socket = useRef<WebSocket | null>(null);
  const [token] = useState(stageToken);
  const [state, setState] = useState<StageState>({ paired: !!token, connected: false, busy: null, display: null });

  useEffect(() => {
    if (!token) return;
    let alive = true;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const ws = new WebSocket(`ws://${RUNNER}/?token=${token}`);
      socket.current = ws;
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "status") setState((s) => ({ ...s, connected: true, busy: msg.busy, display: msg.display }));
        else handler.current(msg);
      };
      ws.onclose = () => {
        if (!alive) return;
        setState((s) => ({ ...s, connected: false, busy: null }));
        retry = setTimeout(connect, RETRY_MS);
      };
    };
    connect();
    return () => {
      alive = false;
      clearTimeout(retry);
      socket.current?.close();
    };
  }, [token]);

  const send = (msg: unknown) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(msg));
  };
  return { ...state, send };
}

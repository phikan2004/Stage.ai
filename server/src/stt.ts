import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";

/**
 * Relays browser microphone audio to Deepgram's streaming API and transcripts
 * back, so DEEPGRAM_API_KEY never leaves the server. Browser connects to
 * ws://…/api/stt?keyterm=…&keyterm=… and sends 16 kHz mono linear16 frames;
 * text frames (e.g. Configure) are forwarded as-is in both directions.
 */
export const DEEPGRAM_MODEL = "nova-3";

const MAX_KEYTERMS = 50;

function deepgramUrl(req: IncomingMessage): string {
  const incoming = new URL(req.url ?? "/", "http://localhost");
  const params = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || DEEPGRAM_MODEL,
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    // Finalize a phrase after 300 ms of silence instead of waiting longer.
    endpointing: "300",
  });
  for (const term of incoming.searchParams.getAll("keyterm").slice(0, MAX_KEYTERMS)) {
    if (term.trim()) params.append("keyterm", term.trim().slice(0, 60));
  }
  return `wss://api.deepgram.com/v1/listen?${params}`;
}

export function attachSttRelay(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/api/stt")) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (client) => relay(client, req));
  });

  function relay(client: WebSocket, req: IncomingMessage) {
    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) {
      client.close(4001, "DEEPGRAM_API_KEY is not set on the server");
      return;
    }

    const upstream = new WebSocket(deepgramUrl(req), { headers: { Authorization: `Token ${key}` } });
    const pending: { data: RawData; isBinary: boolean }[] = [];

    client.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 200) pending.push({ data, isBinary });
    });
    upstream.on("open", () => {
      for (const p of pending.splice(0)) upstream.send(p.data, { binary: p.isBinary });
    });
    upstream.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });

    // Deepgram rejects the handshake with an HTTP status (401 bad key, 400 bad params…).
    upstream.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        const reason = res.statusCode === 401 ? "Deepgram rejected the API key" : `Deepgram error ${res.statusCode}: ${body}`;
        console.error(`stt: ${reason}`);
        client.close(4002, reason.slice(0, 120));
      });
    });
    upstream.on("error", (e) => {
      console.error(`stt upstream error: ${e.message}`);
      if (client.readyState === WebSocket.OPEN) client.close(4003, `Deepgram connection failed: ${e.message}`.slice(0, 120));
    });
    upstream.on("close", (code, reason) => {
      if (client.readyState === WebSocket.OPEN) client.close(code === 1000 ? 1000 : 4004, reason.toString().slice(0, 120));
    });
    client.on("close", () => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(JSON.stringify({ type: "CloseStream" }));
        upstream.close();
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        upstream.terminate();
      }
    });
  }
}

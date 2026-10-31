import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { connectionAllowed } from "./safety.ts";

export interface ConsoleServer {
  url: string;
  broadcast(msg: unknown): void;
  close(): void;
}

/** The link to the Stage console. Binds to this computer only, and takes one known origin plus a per-launch token. */
export function startConsoleServer(opts: { port: number; origins: string[]; token: string; onMessage: (msg: any) => void }): Promise<ConsoleServer> {
  const http = createServer((_req, res) => res.writeHead(426).end());
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  http.on("upgrade", (req, socket, head) => {
    const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
    if (!connectionAllowed(req.headers.origin, token, opts)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      return void socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      ws.on("message", (data) => {
        try {
          opts.onMessage(JSON.parse(data.toString()));
        } catch {
          /* ignore malformed messages */
        }
      });
    });
  });

  return new Promise((resolve) => {
    http.listen(opts.port, "127.0.0.1", () =>
      resolve({
        url: `ws://127.0.0.1:${opts.port}/?token=${opts.token}`,
        broadcast: (msg) => {
          for (const c of clients) c.send(JSON.stringify(msg));
        },
        close: () => {
          wss.close();
          http.close();
        },
      }),
    );
  });
}

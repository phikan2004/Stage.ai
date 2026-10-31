import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(here, "helper", "StageHelper.swift");
const BINARY = join(here, ".build", "stage-helper");

export interface Display {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  main: boolean;
}

/** Compiles only when the source changed: macOS can tie permissions to the exact binary. */
async function build(): Promise<void> {
  const [src, bin] = await Promise.all([stat(SOURCE), stat(BINARY).catch(() => null)]);
  if (bin && bin.mtimeMs >= src.mtimeMs) return;
  console.log("Compiling the Stage helper…");
  await mkdir(dirname(BINARY), { recursive: true });
  await promisify(execFile)("swiftc", ["-swift-version", "5", "-O", "-o", BINARY, SOURCE]);
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** The running Swift helper. One request at a time per id, replies matched by id. */
export class Helper {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private hotkeyHandlers = new Set<(name: string) => void>();

  private constructor(private proc: ChildProcessWithoutNullStreams) {
    createInterface({ input: proc.stdout }).on("line", (line) => this.receive(line));
    proc.stderr.on("data", (d) => process.stderr.write(d));
    proc.on("exit", () => {
      for (const p of this.pending.values()) p.reject(new Error("The Stage helper stopped."));
      this.pending.clear();
    });
  }

  static async start(): Promise<Helper> {
    await build();
    return new Helper(spawn(BINARY, [], { stdio: "pipe" }));
  }

  private receive(line: string) {
    const msg = JSON.parse(line);
    if (msg.event === "hotkey") {
      for (const h of this.hotkeyHandlers) h(msg.name);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.error));
  }

  call<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(`${JSON.stringify({ ...args, id, cmd })}\n`);
    });
  }

  async displays(): Promise<Display[]> {
    return (await this.call<{ displays: Display[] }>("displays")).displays;
  }

  /** Double Esc → "stop", clicker PageDown → "advance", PageUp → "back". */
  async onHotkey(handler: (name: string) => void): Promise<() => void> {
    await this.call("hotkeys");
    this.hotkeyHandlers.add(handler);
    return () => this.hotkeyHandlers.delete(handler);
  }

  stop() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

/** The audience's display: `STAGE_DISPLAY` (part of its name) if set, otherwise the first non-main one. */
export function stageDisplay(displays: Display[], wanted = process.env.STAGE_DISPLAY): Display | undefined {
  if (wanted) return displays.find((d) => d.name.toLowerCase().includes(wanted.toLowerCase()));
  return displays.find((d) => !d.main);
}

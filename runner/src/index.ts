import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { runBeat } from "./agent.ts";
import { BrowserDriver } from "./browserDriver.ts";
import { DesktopDriver } from "./desktopDriver.ts";
import type { Driver } from "./driver.ts";
import { Helper, stageDisplay, type Display } from "./helper.ts";
import { claudeModel, estimateCost, modelName } from "./model.ts";
import type { Limits } from "./safety.ts";
import { startConsoleServer, type ConsoleServer } from "./server.ts";
import { StageSession } from "./session.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: join(root, ".env"), quiet: true, override: true });

const { values: args } = parseArgs({
  options: {
    setup: { type: "boolean" },
    look: { type: "boolean" },
    try: { type: "string" },
    goal: { type: "string" },
    target: { type: "string", default: "desktop" },
    url: { type: "string" },
    allow: { type: "string", default: "" },
    "no-hold": { type: "boolean" },
    "no-fast": { type: "boolean" },
    "release-after": { type: "string" },
  },
});

const DATA_DIR = process.env.DATA_DIR || join(root, "data");
/**
 * The Stage consoles allowed to drive the runner: the always-on local app (5180, demos in local files) and the
 * regular dev app (5173, demos in Supabase). Recordings stay on this Mac either way.
 */
const CONSOLE_ORIGINS = ["http://localhost:5180", "http://localhost:5173"];
const PORT = Number(process.env.STAGE_PORT) || 8788;
/** Started by the login item (npm run stage:install), whose label launchd passes on. */
const AT_LOGIN = process.env.XPC_SERVICE_NAME === "com.stage.dev";

async function requireDesktop(helper: Helper): Promise<Display> {
  const status = await helper.call<{ accessibility: boolean; screen: boolean }>("status");
  const missing = [!status.accessibility && "Accessibility", !status.screen && "Screen Recording"].filter(Boolean);
  if (missing.length) {
    throw new Error(
      AT_LOGIN
        ? `Stage needs ${missing.join(" and ")} permission. In System Settings → Privacy & Security, turn it on for “node” under ${missing.join(" and ")}. Stage notices within a few seconds.`
        : `Stage needs ${missing.join(" and ")} permission. Allow it in System Settings → Privacy & Security for the app Stage was started from, then restart that app.`,
    );
  }
  const displays = await helper.displays();
  const display = stageDisplay(displays);
  if (displays.length < 2 || !display) throw new Error("Stage needs two displays: one for your console, one for the audience.");
  return display;
}

function limitsFromArgs(): Limits {
  const apps = args.allow!.split(",").map((a) => a.trim()).filter(Boolean);
  return { apps, origins: args.url ? [new URL(args.url).origin] : [], taughtCommands: [], taughtActions: [] };
}

async function openDriver(helper: Helper, limits: Limits): Promise<Driver> {
  if (args.target === "browser") {
    const display = stageDisplay(await helper.displays());
    const driver = await BrowserDriver.start({ profileDir: join(DATA_DIR, "stage-profile"), limits, window: display });
    if (args.url) await driver.open(args.url);
    return driver;
  }
  return new DesktopDriver(helper, await requireDesktop(helper));
}

async function look(driver: Driver) {
  const started = performance.now();
  const view = await driver.look();
  const ms = Math.round(performance.now() - started);
  const path = join(DATA_DIR, "stage-look.jpg");
  await writeFile(path, Buffer.from(view.shot.data, "base64"));
  console.log(`${view.app} · ${view.place}\n${view.shot.width}x${view.shot.height} in ${ms}ms, saved to ${path}`);
  for (const e of view.elements) console.log(`  ${e.ref} ${e.role} ${JSON.stringify(e.name)}`);
  const fp = performance.now();
  await driver.fingerprint();
  console.log(`fingerprint in ${Math.round(performance.now() - fp)}ms`);
}

const TRIES: Record<string, (d: Driver) => Promise<void>> = {
  async browser(d) {
    const { elements } = await d.look();
    const first = elements[0];
    if (!first) throw new Error("Nothing clickable on this page.");
    console.log(`Clicking ${first.role} ${JSON.stringify(first.name)}`);
    await d.click("left", first.frame.x + first.frame.width / 2, first.frame.y + first.frame.height / 2);
  },
  async terminal(d) {
    await d.open("Terminal");
    // A new window, so this doesn't type into the one running Stage.
    await d.key("cmd+n");
    await d.look();
    await d.type("echo hello from stage");
  },
  async textedit(d) {
    await d.open("TextEdit");
    await d.key("cmd+n");
    await d.look();
    await d.type("Hello from Stage.");
  },
};

async function goal(helper: Helper, text: string) {
  const limits = limitsFromArgs();
  const driver = await openDriver(helper, limits);
  const stop = new AbortController();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let release = () => {};
  const released = new Promise<void>((r) => (release = r));
  let answer: ((yes: boolean) => void) | null = null;

  process.on("SIGINT", () => stop.abort());
  await helper
    .onHotkey((name) => {
      if (name === "stop") stop.abort();
      if (name === "advance") answer ? answer(true) : release();
      if (name === "back") answer?.(false);
    })
    .catch(() => console.log("Hotkeys are off until Accessibility is granted. Ctrl-C stops."));
  rl.on("line", (line) => (answer ? answer(/^y/i.test(line.trim())) : release()));

  const hold = !args["no-hold"];
  const after = args["release-after"];
  const fast = !args["no-fast"];
  console.log(`${modelName()}${fast ? " (fast)" : ""}, ${hold ? "prepare and hold" : "no hold"}. Enter or PageDown releases. Double Esc stops.`);

  if (!hold && after) setTimeout(release, Number(after));
  const report = await runBeat({
    goal: text,
    driver,
    model: claudeModel({ fast }),
    limits,
    hold,
    release: released,
    signal: stop.signal,
    // The clicker answers too: clicking into this window would take focus away from the demo.
    approve: (q) => {
      console.log(`Approve? ${q}\n  PageDown or y = yes, PageUp or n = no`);
      return new Promise((resolve) => {
        answer = (yes) => {
          answer = null;
          resolve(yes);
        };
      });
    },
    onEvent: (e) => {
      console.log("·", JSON.stringify(e));
      if (after && e.type === "armed") setTimeout(release, Number(after));
    },
  });
  console.log(JSON.stringify({ ...report, target: args.target, hold, fast, estimatedUsd: Number(estimateCost(report.usage, fast).toFixed(4)) }, null, 2));
  rl.close();
  await driver.close();
}

/** Kept between launches, so the console only has to pair once. */
async function pairingToken(): Promise<string> {
  const path = join(DATA_DIR, "stage-token");
  const saved = await readFile(path, "utf8").catch(() => "");
  if (saved.trim()) return saved.trim();
  const token = randomBytes(16).toString("hex");
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path, token, { mode: 0o600 });
  return token;
}

const READY_RETRY_MS = 5000;

/**
 * Serves the console right away, then waits until the Mac is ready (permissions and a second display),
 * telling the console what's missing meanwhile. Starts with the app, so nobody has to run it by hand.
 */
async function serve(helper: Helper) {
  const token = await pairingToken();
  let session: StageSession | null = null;
  let problem: string | null = "Getting the stage display ready…";
  let server: ConsoleServer;
  const waiting = () => server.broadcast({ type: "status", busy: null, display: null, problem });
  try {
    server = await startConsoleServer({
      port: PORT,
      origins: CONSOLE_ORIGINS,
      token,
      onMessage: (m) => session?.handle(m),
      onConnect: () => (session ? session.status() : waiting()),
      frame: (path) => session?.frame(path) ?? Promise.resolve(null),
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    console.log("A Stage runner is already running on this Mac; using that one.");
    helper.stop();
    process.exit(0);
  }
  process.on("SIGINT", () => {
    server.close();
    helper.stop();
    process.exit(0);
  });
  console.log("Stage runner started; the console pairs with it by itself.");

  // Ask macOS for the permissions once, which shows its own prompts, instead of sending anyone to --setup.
  let asked = false;
  while (!session) {
    try {
      const display = await requireDesktop(helper);
      session = new StageSession(helper, display, join(DATA_DIR, "recordings"), server.broadcast);
      await helper.onHotkey((name) => session?.hotkey(name));
      problem = null;
      session.status();
      void session.expireLogs();
      console.log(`Stage runner ready, audience display: ${display.name}.`);
    } catch (e) {
      session = null;
      if (!asked) {
        asked = true;
        await helper.call("request_permissions").catch(() => {});
      }
      const next = e instanceof Error ? e.message : String(e);
      if (next !== problem) console.log(next);
      problem = next;
      waiting();
      await new Promise((r) => setTimeout(r, READY_RETRY_MS));
      // macOS reads permissions when a process starts, so a fresh helper is what notices a new grant.
      helper.stop();
      helper = await Helper.start();
    }
  }
}

/** Proves the safety controls on the real Mac: the display fence, the clicker, and the stop key. */
async function safetyCheck(helper: Helper, driver: Driver) {
  const results: Record<string, boolean | string> = {};
  try {
    await driver.look();
    await driver.click("left", 99_999, 10);
    results.fence = false;
  } catch {
    results.fence = true;
  }
  const waitFor = (name: string, ms: number) =>
    new Promise<number | null>((resolve) => {
      const started = performance.now();
      const timer = setTimeout(() => (off(), resolve(null)), ms);
      let off = () => {};
      helper.onHotkey((h) => {
        if (h !== name) return;
        clearTimeout(timer);
        off();
        resolve(Math.round(performance.now() - started));
      }).then((o) => (off = o));
    });
  console.log("Press PageDown (or your clicker's next button) within 15 seconds.");
  results.clicker = (await waitFor("advance", 15_000)) !== null;
  console.log("The cursor will now circle on the stage display. Press Esc twice quickly to stop it, within 20 seconds.");
  const { shot } = await driver.look();
  let stopped = false;
  const stopping = waitFor("stop", 20_000).then((ms) => (stopped = ms !== null));
  for (let i = 0; !stopped && i < 40; i++) {
    const a = (i / 8) * Math.PI;
    await driver.move(shot.width / 2 + 200 * Math.cos(a), shot.height / 2 + 200 * Math.sin(a));
  }
  await stopping;
  results.stop = stopped;
  console.log(`Safety check: ${JSON.stringify(results)}`);
  console.log(Object.values(results).every(Boolean) ? "PASS" : "FAIL");
}

const helper = await Helper.start();
try {
  if (args.setup) {
    const s = await helper.call("request_permissions");
    console.log(`Accessibility: ${s.accessibility ? "on" : "off"}. Screen Recording: ${s.screen ? "on" : "off"}.`);
    console.log("Displays:", (await helper.displays()).map((d) => `${d.name}${d.main ? " (console)" : ""}`).join(", "));
  } else if (args.look) {
    const driver = await openDriver(helper, limitsFromArgs());
    await look(driver);
    await driver.close();
  } else if (args.try) {
    const run = TRIES[args.try];
    if (!run && args.try !== "safety") throw new Error(`--try takes ${[...Object.keys(TRIES), "safety"].join(", ")}`);
    const driver = await openDriver(helper, limitsFromArgs());
    if (!run) {
      await safetyCheck(helper, driver);
      await driver.close();
      helper.stop();
      process.exit(0);
    }
    await run(driver);
    await new Promise((r) => setTimeout(r, 1500));
    await driver.close();
  } else if (args.goal) {
    await goal(helper, args.goal);
  } else {
    await serve(helper);
    await new Promise(() => {});
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  helper.stop();
}

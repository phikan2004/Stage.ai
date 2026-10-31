import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
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
import { startConsoleServer } from "./server.ts";

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
const CONSOLE_ORIGINS = ["http://localhost:5173"];
const PORT = Number(process.env.STAGE_PORT) || 8788;

async function requireDesktop(helper: Helper): Promise<Display> {
  const status = await helper.call<{ accessibility: boolean; screen: boolean }>("status");
  const missing = [!status.accessibility && "Accessibility", !status.screen && "Screen Recording"].filter(Boolean);
  if (missing.length) {
    throw new Error(`Stage needs ${missing.join(" and ")} permission. Run \`npm run stage -- --setup\`, then allow it in System Settings → Privacy & Security for the app you run this from, and restart that app.`);
  }
  const displays = await helper.displays();
  const display = stageDisplay(displays);
  if (displays.length < 2 || !display) throw new Error("Stage needs two displays: one for your console, one for the audience.");
  return display;
}

function limitsFromArgs(): Limits {
  const apps = args.allow!.split(",").map((a) => a.trim()).filter(Boolean);
  return { apps, origins: args.url ? [new URL(args.url).origin] : [], taughtCommands: [] };
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
  let approving = false;

  process.on("SIGINT", () => stop.abort());
  await helper
    .onHotkey((name) => {
      if (name === "stop") stop.abort();
      if (name === "advance") release();
    })
    .catch(() => console.log("Hotkeys are off until Accessibility is granted. Ctrl-C stops."));
  rl.on("line", () => !approving && release());

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
    approve: async (q) => {
      approving = true;
      const a = await rl.question(`Approve? ${q} [y/N] `);
      approving = false;
      return /^y/i.test(a);
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

async function serve(helper: Helper) {
  const stop = new AbortController();
  const token = randomBytes(16).toString("hex");
  const server = await startConsoleServer({ port: PORT, origins: CONSOLE_ORIGINS, token, onMessage: (m) => m.type === "stop" && stop.abort() });
  console.log(`Stage runner on ${server.url}`);
  process.on("SIGINT", () => {
    server.close();
    helper.stop();
    process.exit(0);
  });
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
    if (!run) throw new Error(`--try takes ${Object.keys(TRIES).join(", ")}`);
    const driver = await openDriver(helper, limitsFromArgs());
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

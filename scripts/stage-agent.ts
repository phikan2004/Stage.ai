/**
 * Runs Stage (the app, its server and the runner, as `npm run stage:dev`) in the background whenever
 * you're logged in, as a macOS login item, so nobody has to start it by hand.
 *
 *   npm run stage:install     add it and start it now
 *   npm run stage:uninstall   stop it and remove it
 *
 * macOS gives Accessibility and Screen Recording to the program a login item runs, which here is Node.
 * Logs go to data/stage-agent.log.
 */
import { execFile } from "node:child_process";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const LABEL = "com.stage.dev";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const log = join(root, "data", "stage-agent.log");
const domain = `gui/${userInfo().uid}`;
const run = promisify(execFile);

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A login item doesn't get your shell's PATH, so it names Node and npm by their real paths. */
async function plist(): Promise<string> {
  const node = await realpath(process.execPath);
  const npm = await realpath(join(dirname(process.execPath), "npm")).catch(async () => realpath((await run("which", ["npm"])).stdout.trim()));
  const path = [dirname(node), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  const args = [node, npm, "run", "stage:dev"].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

const loaded = () => run("launchctl", ["print", `${domain}/${LABEL}`]).then(() => true, () => false);

/** Stops it and waits until launchd has let go, since registering it again too soon fails. */
async function unload() {
  await run("launchctl", ["bootout", `${domain}/${LABEL}`]).catch(() => {});
  for (let i = 0; i < 50 && (await loaded()); i++) await new Promise((r) => setTimeout(r, 200));
}

async function install() {
  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(dirname(log), { recursive: true });
  await writeFile(plistPath, await plist());
  await unload();
  await run("launchctl", ["bootstrap", domain, plistPath]);
  console.log(`Stage now starts by itself when you log in, and is starting now: http://localhost:5180\nLogs: ${log}\nTo remove it: npm run stage:uninstall`);
}

async function uninstall() {
  await unload();
  await rm(plistPath, { force: true });
  console.log("Stage no longer starts at login, and has stopped.");
}

const cmd = process.argv[2];
if (cmd === "install") await install();
else if (cmd === "uninstall") await uninstall();
else {
  console.error("Usage: tsx scripts/stage-agent.ts install|uninstall");
  process.exitCode = 1;
}

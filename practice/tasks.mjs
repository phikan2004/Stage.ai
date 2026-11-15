// A tiny to-do list for practicing Stage demos in Terminal. Tasks live in tasks.json beside this file.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FILE = new URL("./tasks.json", import.meta.url);
const SEED = new URL("./seed.json", import.meta.url);

export const load = () => JSON.parse(readFileSync(existsSync(FILE) ? FILE : SEED, "utf8"));
const save = (tasks) => writeFileSync(FILE, JSON.stringify(tasks, null, 2) + "\n");

export const add = (tasks, title) => [...tasks, { title, done: false }];

export function done(tasks, n) {
  if (!tasks[n - 1]) throw new Error(`There's no task ${n}.`);
  return tasks.map((t, i) => (i === n - 1 ? { ...t, done: true } : t));
}

export const format = (tasks) => tasks.map((t, i) => `${t.done ? "✔" : "○"} ${i + 1}. ${t.title}`).join("\n");

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command = "list", ...rest] = process.argv.slice(2);
  try {
    let tasks = load();
    if (command === "add") {
      tasks = add(tasks, rest.join(" "));
      save(tasks);
    } else if (command === "done") {
      tasks = done(tasks, Number(rest[0]));
      save(tasks);
    } else if (command !== "list") {
      throw new Error("Use: node tasks.mjs list, node tasks.mjs add <title>, or node tasks.mjs done <number>");
    }
    console.log(format(tasks));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}

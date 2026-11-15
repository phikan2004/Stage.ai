import assert from "node:assert/strict";
import { test } from "node:test";
import { add, done, format } from "./tasks.mjs";

const tasks = [{ title: "Write the agenda", done: false }];

test("adds a task to the end", () => {
  assert.deepEqual(add(tasks, "Book the room").at(-1), { title: "Book the room", done: false });
});

test("marks a task done by its number", () => {
  assert.equal(done(tasks, 1)[0].done, true);
});

test("refuses a task that doesn't exist", () => {
  assert.throws(() => done(tasks, 5), /no task 5/);
});

test("shows done and open tasks", () => {
  assert.equal(format(done(add(tasks, "Book the room"), 1)), "✔ 1. Write the agenda\n○ 2. Book the room");
});

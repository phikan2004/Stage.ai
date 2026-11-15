# Practice demo: a terminal to-do app

A two-minute technical demo for practicing with Stage. You teach it once, then the AI performs it live while you talk.
It shows Terminal work: running a small program, changing its data, writing a line of code and running the tests.

## Before you start

- The Stage page goes on your laptop screen. Nothing needs to be open on the HP screen: the first step opens Terminal there.
- Reset the project first, from any Terminal window that isn't on the HP screen:

```bash
"$HOME/PowerPoint Tool/practice/reset.sh"
```

## Teach it

In Stage, create a demo called "Terminal practice" and press **Start recording**. Then do each step on the HP screen
while saying the line beside it. Say the bold words clearly. They become the cues that move the demo on later.

| # | Say | Do |
|---|---|---|
| 1 | "Let me **open up a terminal** so you can see this live." | Open a new Terminal window and move it to the HP screen with Window → Move to HP |
| 2 | "First I'll **jump into the project** and show you what's in it." | `cd "$HOME/PowerPoint Tool/practice"`, then `ls` |
| 3 | "Here's our little app. Let me **show you the task list**." | `node tasks.mjs list` |
| 4 | "Now I'll **add a brand new task** for this meeting." | `node tasks.mjs add "Prepare the client demo"` |
| 5 | "And let's **mark the first one done**." | `node tasks.mjs done 1` |
| 6 | "Now I'll **write a tiny bit of code**, a one-line greeting." | `echo 'console.log("Hello, " + (process.argv[2] ?? "world") + "!")' > hello.mjs` |
| 7 | "Let's **run the code we just wrote** for our client." | `node hello.mjs Acme` |
| 8 | "Finally, **run the test suite** to prove it all works." | `node --test` |

Press **Stop and learn**. Type each command exactly as written, because Stage only runs commands it saw you type.

## Check what it learned

- **Beats:** there should be about 8, one per row above.
- **Cue words:** each beat's cue words should include the bold phrase. If one is a single common word like "task",
  change it to the phrase.
- **Limits:** Apps should list Terminal. Terminal commands should list the 8 commands above, matching character for
  character.

## Dry run

1. Run the reset command again and close the Terminal window on the HP screen.
2. Press **Start dry run**. The HP screen goes black.
3. Present it as if a client were watching, saying your lines. Each step runs when you reach its cue.

Double Esc stops everything. Space or Return moves on if a cue misses you.

## Things to try once it works

- Say your lines in different words, and see how far you can drift before a cue misses.
- Talk between steps without the cue phrases, and check nothing fires.
- In step 4, say a different task name. The AI types what it was taught, so this shows that taught commands are
  fixed for now.

What you'll see when it works: the task list with three tasks, then four, then the first one ticked, `Hello, Acme!`,
and the tests reporting `pass 4`.

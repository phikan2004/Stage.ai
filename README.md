# Stage

A prototype presentation surface that listens while you present and automatically zooms into the part of the slide
you're talking about. It exists to answer one question: **does the effect feel good?**

## Setup

Requires Node 20+ and Chrome (for live speech recognition).

```bash
npm install
cp .env.example .env   # add ANTHROPIC_API_KEY to enable automatic slide analysis
npm run dev            # API on :8787, app on http://localhost:5173
```

Get an API key at [console.anthropic.com](https://console.anthropic.com). It's billed per request, separately from a
Claude Pro/Max subscription. The server reloads automatically when you save `.env`. If Claude declines a slide on
safety grounds, the request is re-run on Anthropic's recommended fallback model (`fallbacks: "default"`).

No API key? On the home page, click **Try the sample deck**. It ships with hand-checked regions, so you can try the
whole flow without calling the vision model.

| Script | What it does |
|---|---|
| `npm run dev` | Server (tsx watch) + Vite client together |
| `npm test` | Vitest: matcher, restraint state machine, zoom math, end-to-end scripted scenarios |
| `npm run build` | Type-check + production build of the client, type-check of the server |
| `npm run make-sample` | Regenerates `client/public/sample/sample.pdf` + `sample.regions.json` |

## Projects, decks, demos and runs

- The top bar has three tabs: **Projects** (`#/projects`), **Decks** (`#/`) and **Demos** (`#/demos`). Each can be
  sorted and searched.
- **New** adds a project, a deck (PowerPoint or PDF, several at once) or a demo. A deck or demo goes into a project or
  stands on its own.
- A **project** (`#/m/<id>`) lists its decks and demos as rows. Click one to see more, then open it. In the code and
  database a project is still called a matter; a deck or demo on its own lives in a hidden one (`solo`).
- A demo's cover is a screenshot from its recording, chosen on the demo's page. It's served by the runner on your Mac,
  so it only shows while the runner is running.
- A **run** is one time you presented a deck. It's saved when you leave the presenter (runs under 5 s are skipped) and
  records the slides shown, every zoom, every voice command and what was heard. Run history isn't linked from the
  app right now, but runs are still saved and each one's page still works at `#/r/<id>`.
- Region edits autosave as you work. The top bar shows Saving…/Saved.

## Stage (in progress)

Stage is an AI operator for live software demos: you talk, and it performs the demo on your Mac. It always acts live
from the real screen, and nothing is replayed. While you're still talking, it decides its next actions and holds them
until you reach that moment, then checks the screen hasn't changed and runs them. If it has changed, it decides again.

It has two parts: the runner in `runner/`, a local process with a Swift helper for screen and input, and the Demos tab.
The app has three tabs: Projects, Decks and Demos. A project holds decks and demos together, and either can also stand on
its own. It runs on your Mac because a web page can't control other apps and Vercel can't reach your computer.

To teach a demo, start both of these in Terminal, then open <http://localhost:5180> and choose New → Demo. The first
time, open the pairing link the runner prints.

```bash
npm run stage:dev
```

```bash
npm run stage
```

1. **Teach:** press Start recording, do the demo on the audience display while talking through it, then press Stop and
   learn. Only that display, what you do on it, and your voice are recorded. Password fields aren't. Recordings are
   saved in `data/recordings/`. To learn the demo, screenshots, what you typed and what you said are sent to Claude, and
   your voice goes to the speech service as you talk. Known key and password formats are hidden from that text, but
   screenshots are sent as they are, so keep real secrets off the stage display.
2. **Review:** check the beats and the limits, including which risky buttons it may press. Add corrections in each
   beat's notes.
3. **Dry run:** the screen goes black while the AI gets ready, and the mic comes on. Say the first beat's cue (one of
   its phrases or two of its words) and it performs that beat live. After that it follows you the way a person helping
   would: once a beat is done, the next one runs as soon as you mention it, when you finish your thought (1.5 s quiet),
   or after 3 s if you say nothing. A short "hold on", "wait" or "stop" holds it, and "go ahead" or "next" carries on.
   Those only count as a short sentence of their own, so "I can't wait to show you" won't hold it. Space, Return or the
   Right arrow also move on. Each beat is scored. Set `STAGE_PACE` in `.env` to change how fast it moves. Dry runs don't reset your demo yet, so put it back
   to its starting state yourself between runs.

`stage:dev` uses its own ports and stores data in `data/`, away from Supabase and from any other dev server. Using demos
with Supabase needs the `producer.shows` migration, which applies when it reaches production.

| Command | What it does |
|---|---|
| `npm run stage` | Starts the runner for the Demos tab |
| `npm run stage -- --setup` | Asks macOS for Accessibility and Screen Recording, and lists your displays |
| `npm run stage -- --look` | Prints what it sees on the stage display |
| `npm run stage -- --try textedit` | Performs one action with no AI (`browser`, `terminal` or `textedit`) |
| `npm run stage -- --try safety` | Tests the stop key, the clicker and the display limit on your Mac |
| `npm run stage -- --goal "…" --allow TextEdit` | Runs the live agent on one goal |
| `npm run stage -- --goal "…" --target browser --url http://localhost:5173` | The same, in Chrome |

Enter or a clicker's PageDown releases held actions. Double Esc stops everything, whichever app is in front. Add
`--no-hold` or `--no-fast` to compare timings.

**Before using this for real, create a separate macOS user account** with only demo logins and data. An AI with mouse
and keyboard control can reach anything the logged-in user can. Permissions belong to the app you start the runner
from, such as Terminal. Grant them in System Settings → Privacy & Security, then restart that app. The first time a demo opens a website, macOS also asks
whether that app may control Google Chrome. Allow it, because that's how a site gets its own window on the stage display.

Safety limits: the agent only acts in the apps and web origins you allow, on the stage display. During a demo it refuses
terminal commands you haven't taught it, and buttons like Delete, Send or Pay unless you pressed them while teaching or
added them in review. `--goal` runs from the command line ask you instead. It recognizes risky buttons by their names in
English, so an unlabelled icon isn't caught. It treats on-screen
text as data, never as instructions, and has a limit on actions and time per beat. It needs two displays for desktop
control.

## Storage: Supabase or local

**Supabase** (used when `DATABASE_URL`, `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are set in `.env`): data lives in a
dedicated `producer` Postgres schema, defined in `supabase/migrations/`:

| Table | Holds |
|---|---|
| `producer.matters` | Projects |
| `producer.decks` | Presentations: name, file hash, slide count, analyzed flag, Storage paths |
| `producer.regions` | One row per region: slide, order, label, description, `keywords text[]`, box (CHECKed to stay on the slide) |
| `producer.runs` | One row per presentation run, with stored stats |
| `producer.run_events` | The run timeline: slide changes, zooms, voice commands, what was heard |

Deleting a matter cascades to its decks, regions, runs and events. Triggers keep `updated_at` and each matter's
last-activity time current. The views `matter_summaries`, `deck_summaries` and `run_summaries` feed the lists. Deck files and
thumbnails go to the private Storage bucket `producer-decks`. The server talks to Postgres directly, so the schema isn't
exposed through the Data API: RLS is on with no policies, and the `anon`/`authenticated` roles have no grants.

The GitHub integration applies the migration when it's pushed to the production branch. You can also paste the SQL
file into the Supabase SQL editor. The server refuses to start if Supabase is configured but the schema is missing.

**Local** (when those variables are empty): `data/db.json` plus `data/decks/<id>/deck.pptx` or `deck.pdf`, and `thumb.jpg`. Set
`DATA_DIR` to put it elsewhere. Local data isn't copied to Supabase when you switch.

Deck files don't pass through the server when using Supabase: the browser uploads to a signed Storage URL, then
registers the deck, and `GET /api/decks/:id/file` redirects to a 5-minute signed download URL. An upload that's never registered
leaves an unused file in the bucket.

## Deploying to Vercel

`vercel.json` deploys `client/` and `server/` as one project using [Services](https://vercel.com/docs/services) (beta).

1. Import the repo with the **Services** framework preset and Root Directory `./`. Don't use "Import single project".
2. Add the variables from `.env`. `DATABASE_URL` must be the **Transaction pooler** string (port 6543), and the
   Deepgram key needs the **Member** role. The server won't start on Vercel without the Supabase variables.
3. Under **Settings → Deployment Protection**, choose **All Deployments** with **Vercel Authentication**. Stage has
   no login of its own, so without this anyone with the URL can read and delete your matters and use your API keys.

The server's build command is `npm run typecheck` on purpose: an explicit build command makes Vercel skip its own type
check, which doesn't work with TypeScript 7. Vercel still bundles the server.

## Flow

1. **Add a deck** with New → Deck and choose a PowerPoint (`.pptx`) or PDF. The original
   file is stored, and each slide is rendered to an image in the browser, with `@silurus/ooxml` for
   PowerPoint and pdf.js for PDF. Slides hidden in PowerPoint are left out and animations show their final state.
   Fonts that aren't embedded or available fall back to substitutes (Carlito for Calibri, from Google Fonts). Older
   `.ppt` files and password-protected decks aren't supported.
2. **Add cues** in Review: drag on a slide to mark something, then give it a label and a cue type in the popup. A box
   you don't name disappears. Drag boxes to move them, pull corners to resize, and press `Del` to remove one. Or press
   **Suggest cues** to have Claude read the whole deck and propose them. Changes save automatically.
3. **Check** the cues while presenting, or adjust them in Review.
4. **Present**: full-screen slide, continuous speech recognition, automatic zoom.

## Plans and analysis

`shared/plans.ts` defines what each plan uses, and `PRODUCER_PLAN` picks one. There are no accounts yet, so the whole app
runs on a single plan.

| | Free | Premium (default) |
|---|---|---|
| Model | Sonnet 5.5, medium effort | Opus 5.5, high effort per slide, xhigh for the plan |
| Suggest cues | Each slide on its own | Whole-deck director, then each planned slide |
| While presenting | Any region can fire on keywords | Guided: overview, evidence and order |

**The director** (`POST /api/decks/:id/plan`) sends every slide at low resolution in one request, sized to stay under
Vercel's 4.5 MB limit. Claude decides what each slide is for and what deserves emphasis, usually 1 to 3 items and none on
title or simple slides, picks `outline` or `zoom` for each, and puts them in speaking order. The per-slide pass then finds
exactly those items and writes the phrases a presenter would say. A slide with nothing planned makes no Claude call. If
planning fails, slides are analyzed one at a time.

**Cue types:** Outline, Spotlight (dims the rest), Zoom, Highlight (a marker sweep over each line of text), Callout (an
outline plus the label), Arrow, and Reveal (hidden until the presenter reaches it). `client/src/components/CueOverlay.tsx`
draws them.

**PowerPoint files state a lot outright**, so reading it costs nothing: `renderPptx` collects each slide's speaker notes
and exact text boxes (`SlideFacts`). Claude reads slide images as usual and gets these alongside, so its plan follows the
notes and its boxes match the real text. PDFs and scans have no such data, so boxes there are estimates.

**Analysis depth follows the cue.** `CUE_EFFORT` in `shared/plans.ts` sets how hard Claude thinks about a drawn cue: low
for cues that only need to know how the area will be referred to, medium for Zoom, Callout and Highlight. Highlight lines
(`findLines`) and Reveal covers come from the slide image in the browser, with no API call.

**Cues** come from dragging on a slide in Review or from **Suggest cues**, which only fills slides that have no cues, so
anything you drew stays. The popup asks for just a label and a cue type, and a box you leave unnamed disappears without being saved. Once a cue
has a label, Claude reads the marked area in the background (`POST /api/analyze/region`) to work out its keywords and
phrases, about a cent per cue, and does it again if the box moves.

**Guided slides** are any slide whose regions have a cue (`client/src/engine/guidance.ts`). Nothing can fire during the
overview, and words spoken then don't count afterward. After that only the next step can fire, and it needs two words
unique to that region, or one word plus a lead-in like "if you look at". Saying one of a region's own phrases fires it
in any order, so going back or skipping ahead works.

**Timings tune themselves.** `tuneForSlide` (`client/src/engine/tune.ts`) sets them per slide from what's on it and the
presenter's measured pace: a longer overview for fuller slides, more hold time for bigger regions, and a longer
transcript window for slower speakers. The debug panel's sliders remain as a developer tool.

**Usage:** every billed Claude call is saved with its real token counts and cost, including retries and failures
(`producer.analysis_usage`, kept after a deck is deleted). It isn't shown in the app; `GET /api/decks/:id/usage` returns a
deck's total. Prices live in `shared/plans.ts`.

## Present controls

| Key | Action |
|---|---|
| `→` / `←` (also PageDown/PageUp, Space) | Next / previous slide (always zooms out) |
| `Esc` | Zoom out now. Press again (when not zoomed) to leave full-screen, and again to return to the editor (this saves the run) |
| `A` | Toggle automation (bottom-left dot: orange = auto) |
| `D` | Debug panel |
| `F` | Toggle full-screen |

### Voice commands

Say these as their own short phrase, with a brief pause before and after:

| Say | Does |
|---|---|
| "Next slide", "Next", "Next one", "Move on" | Next slide |
| "Go back", "Previous slide", "Back to the last slide" | Previous slide |
| "Go to slide 3", "Slide three" | Jump to a slide |
| "First slide", "Back to the beginning" / "Last slide" | Jump to the start / end |
| "Zoom out", "Show the whole slide" | Zoom out |

A command only fires when it's a sentence by itself, so "on the next slide you'll see…" or "the previous quarter"
never changes slides. Wrapping words like "okay", "let's" and "please" are fine. A small label confirms each
command. You can turn commands off in the debug panel. The parsing is in `client/src/engine/commands.ts` and tested
in `commands.test.ts`.

### Debug panel

- **Simulate speech**: type a phrase and press Enter. It goes through the same pipeline as the mic, so you can tune
  without talking.
- **Transcript**: what's in the rolling window right now (interim text in italics).
- **Scores**: each region's live score. The tick on each bar marks the confidence threshold, and the line below shows the lead over
  the runner-up versus the required margin.
- **State**: `idle → dwell → zoomed → cooldown`.
- **Sliders**: every threshold and timing lives in `client/src/engine/config.ts`. Slider values persist in
  localStorage, and **Reset defaults** restores them.
- **Show region outlines** draws every region on the live slide.

## How matching and restraint work

All of this is pure TypeScript with no DOM or timers (`client/src/engine/`), driven by a 100 ms tick in `PresentView`.

- **Window** (`transcriptWindow.ts`): the last ~6 s of transcript. Interim results replace each other and count at
  0.6× weight.
- **Matcher** (`matcher.ts`): words are lowercased, stopwords and fillers are dropped, and the rest are Porter-stemmed. Each region
  is scored by its keywords (1.0) and label words (0.6), using the best match per term. Matches can be exact or fuzzy
  (Damerau-Levenshtein similarity ≥ 0.8 for words of 4+ letters; numbers must match exactly). Words count less as they age
  (100% → 30% across the window). Multi-word keywords spoken in order get a bonus, and words shared by k regions on the slide
  count 1/k. The raw sum is squashed to 0–1.
- **Restraint** (`restraint.ts`):
  - Zoom only if the top score ≥ **0.45** *and* beats #2 by ≥ **0.15**.
  - Stay at least **3 s** before switching to another region.
  - Stay zoomed while the current region keeps scoring ≥ 0.25. Zoom out **4 s** after it stops.
  - After zooming out, a **0.8 s** cooldown prevents flapping.
  - A slide change zooms out instantly and clears the window. Esc zooms out and holds off for 1.5 s.
- **Zoom** (`zoom.ts`): scale to fit the region plus padding, capped at 3×. Translation is clamped so the slide always covers
  the viewport, so you never see area outside the slide. Rendering uses a CSS transform (600 ms ease) with a dim overlay cut out
  around the region.

## Speech engines

Two engines sit behind the same `SpeechSource` interface (`client/src/speech/`), and you switch between them in the debug panel:

- **Deepgram Nova-3** (default when `DEEPGRAM_API_KEY` is set). The browser captures the mic, downsamples it to 16 kHz
  PCM in an AudioWorklet, and streams 40 ms frames straight to Deepgram. `POST /api/stt/session`
  (`server/src/stt.ts`) gives the browser the streaming URL and a 60-second token, which only has to be valid when the
  socket opens, so the key never leaves the server and long presentations aren't cut off by serverless time limits.
  The current slide's keywords and labels are sent as `keyterm` boosts, so terms like "Q1" or "APAC" are recognized
  reliably, and they're updated mid-stream on each slide change. Get a key at console.deepgram.com → API Keys. It
  needs the **Member** role or higher, because lower roles can't create tokens.
- Streams set Deepgram's `mip_opt_out`, so audio isn't kept for model training.
- **Chrome built-in** (Web Speech API). Free, no key, but slower to settle and no keyword boosting.

`ScriptedSpeechSource` replays a timestamped script and powers the debug panel's simulate box. To add another
provider, implement `SpeechSource` and add it to the engine switch in `PresentView.tsx`.

## Known limitations

- **Chrome only for the built-in engine.** (Deepgram works in any modern browser.) The Web Speech API isn't available in Firefox, and Safari's version is unreliable.
  Elsewhere the HUD shows "No mic" and the simulate box still works.
- **Web Speech is cloud-based.** Chrome sends audio to Google. It needs a network connection, adds roughly 300–1000 ms of
  latency, and ends sessions on its own. Stage restarts it automatically, with backoff after errors. A dedicated
  streaming STT would be faster and more private.
- **Vision bounding boxes are approximate.** Models are good at what a region is and what words describe it, but boxes
  are often off by 5–20%. Expect to fix boxes in Review. The sample deck's regions are exact on purpose, so you can judge
  the zoom effect apart from detection quality.
- **Keyword matching, not meaning.** Paraphrases that share no words with a region's keywords won't trigger it. Adding
  the phrases you actually say is the fix for now.
- Esc as "zoom out" while full-screen relies on Chrome's Keyboard Lock API. Without it, the browser takes the first Esc
  to exit full-screen (Stage also zooms out when that happens).
- Single-user storage: one JSON file on the server, no accounts. Opening a deck re-renders its file in the browser
  (the last 3 decks stay cached for the tab).
- A run is saved when the presenter closes. If the tab is closed mid-presentation it's sent with `sendBeacon`, which
  is best-effort.
- Rendering is at ~1600 px wide JPEG, so very small text will get soft at 3× zoom.

## Layout

```
shared/schema.ts          zod schemas shared by client + server (Region, ProducerFile)
server/src/               Express: /api/health, /api/analyze (Claude vision, validate, retry), stt.ts (Deepgram tokens),
                          library.ts (routes), store.ts (local JSON), supabaseStore.ts (Postgres + Storage)
supabase/migrations/      the `producer` schema
scripts/make-sample.ts    pdfkit sample deck + exact regions
client/src/engine/        pure matching / restraint / zoom logic + tests
client/src/speech/        SpeechSource interface, Web Speech + scripted implementations
client/src/components/    Home, Matter, Deck (Review → Present), Run, Debug panel
client/src/lib/           api client, hash router, deck upload/cache, PDF and PowerPoint rendering
```

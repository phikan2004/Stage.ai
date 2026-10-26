# Producer

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

No API key? Click **Load sample deck**. It ships with hand-checked regions, so you can try the whole flow without
calling the vision model.

| Script | What it does |
|---|---|
| `npm run dev` | Server (tsx watch) + Vite client together |
| `npm test` | Vitest: matcher, restraint state machine, zoom math, end-to-end scripted scenarios |
| `npm run build` | Type-check + production build of the client, type-check of the server |
| `npm run make-sample` | Regenerates `client/public/sample/sample.pdf` + `sample.regions.json` |

## Flow

1. **Upload** a PDF. Each page is rendered to an image in the browser with pdf.js. If you drop a `.regions.json`
   alongside it, analysis is skipped.
2. **Analyze**: each slide image goes to `POST /api/analyze`, which asks Claude (`VISION_MODEL`, default
   `claude-opus-5-5`, structured JSON output) for 3–8 regions with a label, description, 5–10 spoken keywords and a bounding box. The response is
   validated with zod, boxes are clamped to the slide, and an invalid answer is retried once with the error fed back.
   Two slides are analyzed at a time.
3. **Review**: drag boxes to move them, pull corners to resize, drag on empty space (or press `N`) to draw, `Del` to
   delete, and edit labels/keywords in the side panel. **Download regions** saves a versioned JSON file (with a SHA-256
   of the PDF) that you can load later to skip analysis. You get a warning if it doesn't match the PDF.
4. **Present**: full-screen slide, continuous speech recognition, automatic zoom.

## Present controls

| Key | Action |
|---|---|
| `→` / `←` (also PageDown/PageUp, Space) | Next / previous slide (always zooms out) |
| `Esc` | Zoom out now. Press again (when not zoomed) to leave full-screen, and again to return to the editor |
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
  PCM in an AudioWorklet, and streams 40 ms frames to the server's `/api/stt` WebSocket relay
  (`server/src/stt.ts`), which forwards them to Deepgram. The key never leaves the server. The current slide's
  keywords and labels are sent as `keyterm` boosts, so terms like "Q1" or "APAC" are recognized reliably, and
  they're updated mid-stream on each slide change. Get a key at console.deepgram.com → API Keys (Member role is
  enough).
- **Chrome built-in** (Web Speech API). Free, no key, but slower to settle and no keyword boosting.

`ScriptedSpeechSource` replays a timestamped script and powers the debug panel's simulate box. To add another
provider, implement `SpeechSource` and add it to the engine switch in `PresentView.tsx`.

## Known limitations

- **Chrome only for the built-in engine.** (Deepgram works in any modern browser.) The Web Speech API isn't available in Firefox, and Safari's version is unreliable.
  Elsewhere the HUD shows "No mic" and the simulate box still works.
- **Web Speech is cloud-based.** Chrome sends audio to Google. It needs a network connection, adds roughly 300–1000 ms of
  latency, and ends sessions on its own. Producer restarts it automatically, with backoff after errors. A dedicated
  streaming STT would be faster and more private.
- **Vision bounding boxes are approximate.** Models are good at what a region is and what words describe it, but boxes
  are often off by 5–20%. Expect to fix boxes in Review. The sample deck's regions are exact on purpose, so you can judge
  the zoom effect apart from detection quality.
- **Keyword matching, not meaning.** Paraphrases that share no words with a region's keywords won't trigger it. Adding
  the phrases you actually say is the fix for now.
- Esc as "zoom out" while full-screen relies on Chrome's Keyboard Lock API. Without it, the browser takes the first Esc
  to exit full-screen (Producer also zooms out when that happens).
- Analysis results are kept in memory. Download the regions file to keep your edits.
- Rendering is at ~1600 px wide JPEG, so very small text will get soft at 3× zoom.

## Layout

```
shared/schema.ts          zod schemas shared by client + server (Region, ProducerFile)
server/src/               Express: /api/health, /api/analyze (Claude vision, validate, retry)
scripts/make-sample.ts    pdfkit sample deck + exact regions
client/src/engine/        pure matching / restraint / zoom logic + tests
client/src/speech/        SpeechSource interface, Web Speech + scripted implementations
client/src/components/    Upload, Analyze, Review editor, Present, Debug panel
```

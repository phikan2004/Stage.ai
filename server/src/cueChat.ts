import { z } from "zod";
import type { Effort } from "../../shared/plans.ts";
import type { CueChatReply, CueChatRequest, DeckChange } from "../../shared/rehearse.ts";
import { CueSchema, type DeckRecord } from "../../shared/schema.ts";
import { callModel, imageBlock, requireKey, withRetry, type UsageSink } from "./analyze.ts";
import { CUE_GUIDE, factsPrompt } from "./prompt.ts";
import { describeDeck, history } from "./rehearse.ts";

/*
 * The cue chat in the deck editor: the presenter says how the cues should work and Claude, looking at the slide,
 * turns it into edits. The browser applies them with applyDeckChanges and saves them like any edit, with Undo.
 */

const CHAT_EFFORT: Effort = "medium";

const PROMPT = `You help a presenter set up the cues on their slides in Stage. While they present, Stage listens and emphasizes parts of the slide (regions) as they start talking about each one. You can see the slide on screen. The presenter tells you in plain words how they want the cues to work, and you make the edits.

How cues work:
- Each region has a box on the slide, a label, a cue type, keywords and trigger phrases. When recent speech matches one region clearly better than the others, its cue fires.
- On a slide where the regions have cue types, they're expected in their listed order, so order matters: setOrder changes it.
- To make a cue fire sooner or more reliably, add phrases the presenter would naturally say on reaching it. To stop it firing too early or by mistake, remove generic keywords or phrases that also come up elsewhere and add distinctive ones.

Cue types, lightest that works:
${CUE_GUIDE}

Ops and their fields (fill fields an op doesn't use with "", [] , cue "none" and a zero box):
- addRegion: slide, label (2 to 5 words), cue, box, text (one sentence describing what it shows), keywords (items: 5 to 10 words specific to it, including spoken numbers such as "38 percent"), phrases (3 to 6 things the presenter would say on reaching it, 3 to 7 words, natural speech)
- setBox: slide, regionId, box. Use it to move, grow or shrink a region.
- setLabel: slide, regionId, text
- setCue: slide, regionId, cue
- removeRegion: slide, regionId
- addPhrases, removePhrases, setKeywords: slide, regionId, items
- setOrder: slide, items (every region id on the slide, in the new order). A region you add in the same answer gets the id of its label in lowercase with hyphens, such as "q3-revenue" for "Q3 revenue".

Boxes are fractions of the slide's width and height: x, y = top-left corner, w, h = size, all between 0 and 1. Measure carefully against the image and include the item's own labels and values. If the slide's exact text boxes are listed and the item is one of them, copy that box. Existing regions' boxes are listed, so you can place new ones relative to them.

Slides are numbered from 1. "This slide" is the one on screen, whose image you see. You may change other slides when asked ("do the same on every slide"), but only by region ids listed for them; you can't add regions to slides you can't see.

If the request is unclear, make no changes and ask one short question. If it can't be done with these edits, say so and what they can do instead (for example, how fast cues fire overall is in the debug panel while presenting; press D).

reply: 1 to 3 short, plain sentences on what you changed and why, naming regions by their labels. Don't mention ids or op names.`;

const BOX = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y", "w", "h"],
  properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
} as const;

const OPS = ["addRegion", "setBox", "setLabel", "setCue", "removeRegion", "addPhrases", "removePhrases", "setKeywords", "setOrder"] as const;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "changes"],
  properties: {
    reply: { type: "string" },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "slide", "regionId", "label", "cue", "box", "text", "items", "keywords", "phrases"],
        properties: {
          op: { type: "string", enum: OPS },
          slide: { type: "integer" },
          regionId: { type: "string" },
          label: { type: "string" },
          cue: { type: "string", enum: [...CueSchema.options, "none"] },
          box: BOX,
          text: { type: "string" },
          items: { type: "array", items: { type: "string" } },
          keywords: { type: "array", items: { type: "string" } },
          phrases: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

const Raw = z.object({
  reply: z.string(),
  changes: z.array(
    z.object({
      op: z.enum(OPS),
      slide: z.number().int(),
      regionId: z.string(),
      label: z.string(),
      cue: z.string(),
      box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
      text: z.string(),
      items: z.array(z.string()),
      keywords: z.array(z.string()),
      phrases: z.array(z.string()),
    }),
  ),
});

/** The slide on screen in detail: each region with its box, so new ones can be placed and old ones moved. */
function describeSlide(deck: DeckRecord, index: number): string {
  const regions = deck.slides.find((s) => s.index === index)?.regions ?? [];
  const f = (n: number) => n.toFixed(3);
  const list = regions.map((r, i) => `${i + 1}. [${r.id}] "${r.label}" (${r.cue ?? "zoom"}) box x=${f(r.box.x)} y=${f(r.box.y)} w=${f(r.box.w)} h=${f(r.box.h)}`);
  return `On screen: slide ${index + 1}. Its regions, in order:\n${list.join("\n") || "(none yet)"}`;
}

/** Turns a raw op into a typed change, dropping any that are missing what they need. */
function toChange(c: z.infer<typeof Raw>["changes"][number]): DeckChange[] {
  const cue = CueSchema.safeParse(c.cue);
  switch (c.op) {
    case "addRegion":
      return cue.success ? [{ op: c.op, slide: c.slide, label: c.label, cue: cue.data, box: c.box, description: c.text, keywords: c.keywords, phrases: c.phrases }] : [];
    case "setCue":
      return cue.success ? [{ op: c.op, slide: c.slide, regionId: c.regionId, cue: cue.data }] : [];
    case "setBox":
      return [{ op: c.op, slide: c.slide, regionId: c.regionId, box: c.box }];
    case "setLabel":
      return [{ op: c.op, slide: c.slide, regionId: c.regionId, text: c.text }];
    case "removeRegion":
      return [{ op: c.op, slide: c.slide, regionId: c.regionId }];
    case "setOrder":
      return [{ op: c.op, slide: c.slide, items: c.items }];
    default:
      return [{ op: c.op, slide: c.slide, regionId: c.regionId, items: c.items }];
  }
}

export async function cueChat(deck: DeckRecord, req: CueChatRequest, onUsage: UsageSink): Promise<CueChatReply> {
  requireKey();
  // The editor's copy of this slide is the latest; its autosave may not have landed yet.
  const slides = deck.slides.some((s) => s.index === req.slide)
    ? deck.slides.map((s) => (s.index === req.slide ? { ...s, regions: req.regions } : s))
    : [...deck.slides, { index: req.slide, regions: req.regions }];
  deck = { ...deck, slides };
  const text = [
    `The whole deck:\n${describeDeck(deck)}`,
    `${describeSlide(deck, req.slide)}${factsPrompt(req.facts)}`,
    `${history(req.history)}The presenter: ${req.message}`,
  ].join("\n\n");
  return withRetry("chat answer", async (retryError) => {
    const raw = Raw.parse(
      await callModel({
        system: PROMPT,
        schema: SCHEMA,
        content: [imageBlock(req.image), { type: "text", text: retryError ? `${text}\n\nYour previous answer was invalid: ${retryError}` : text }],
        effort: CHAT_EFFORT,
        maxTokens: 12000,
        usage: (u) => onUsage({ ...u, kind: "region", slideIndex: req.slide }),
      }),
    );
    return { reply: raw.reply.trim(), changes: raw.changes.flatMap(toChange) };
  });
}

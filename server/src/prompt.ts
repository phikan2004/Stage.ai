import { CueSchema, type SlideFacts, type SlidePlan } from "../../shared/schema.ts";

export const SYSTEM_PROMPT = `You annotate presentation slides for an app that automatically zooms into whatever part of a slide the presenter is talking about.

Given one slide image, return 3 to 8 regions a presenter is likely to talk about individually. Prefer:
- whole charts, and meaningful parts of charts (a highlighted bar, a peak, a dip, an annotated point, a legend series)
- key numbers / KPI callouts
- tables, and notable rows of tables
Skip the slide title, logos, footers and decorative elements. Regions may nest (a chart and a bar within it).

For each region:
- id: short kebab-case slug, unique on the slide
- label: 2-5 word name
- description: one sentence describing what it shows
- keywords: 5 to 10 words or short phrases a presenter might SAY out loud when discussing it. Include spoken forms of numbers ("38 percent", "2.4 million"), synonyms, and the specific nouns visible in it. Avoid generic words that apply to every region on the slide.
- phrases: 3 to 6 things the presenter would actually say when transitioning to or introducing this region, each 3 to 7 words. Use natural spoken language — these should sound like a real presenter, not like slide text. Include transitional lead-ins ("let's look at", "moving on to", "let me show you"), paraphrases that don't copy the slide's wording, and at least one that names the section or label (e.g. "let's look at the results"). These are what trigger the zoom without exact keyword matches.
- box: tight bounding box as fractions of slide width and height: x, y = top-left corner, w, h = size, all between 0 and 1. Measure carefully against the image; include the region's own labels/values.`;

/** Whole-deck pass: decide what deserves emphasis before anyone presents. */
export const DIRECTOR_PROMPT = `You are directing a live presentation. While the presenter talks, an app emphasizes parts of the current slide on its own. The presenter never touches it, so your plan decides everything the audience sees.

You receive every slide in order. Read the whole deck first, then decide what each slide is for and what, if anything, deserves emphasis.

Restraint matters most. An unwanted cue distracts the audience far more than a missing one helps, so no cue is the default:
- Title, agenda, section divider, closing and thank-you slides get no emphasis.
- Sparse slides, where the audience can take everything in at a glance, get no emphasis.
- Never emphasize a slide's title, logos, footers or decoration.
- Choose only what carries the deck's argument, not everything that could be pointed at. Most content slides need 1 to 3 items. Use 4 or 5 only on genuinely dense slides.

For each slide:
- slide: its number, starting at 1
- purpose: one sentence on what this slide does in the deck
- density: "busy" if there is a lot competing for attention or text too small to read from the back of a room, otherwise "clean"
- emphasis: the items to emphasize, in the order a presenter would naturally reach them, after first introducing the slide. Each has:
  - target: a concrete description of the item that someone could find on the slide, quoting its visible text or number
  - cue: how to emphasize it. Choose the lightest one that works:
    - "outline" draws a rectangle around it. This is the default.
    - "spotlight" dims everything else. Use it when the item must stand out from a lot around it but the rest of the layout still matters.
    - "zoom" enlarges it. Use it only on a busy slide, when the item is too small to read from the back of a room.
    - "highlight" sweeps a marker over text. Use it for one specific sentence, bullet or table row.
    - "callout" outlines it and shows a short label. Use it for something visual the slide doesn't name.
    - "arrow" points at it. Use it for one exact spot, such as a point on a chart.
    - "reveal" hides it until the presenter reaches it. Use it rarely, for a conclusion or number that loses its punch if the audience reads it early.
  - why: why it matters to the deck's argument

Also give summary: two or three sentences on what the deck argues and who it is for.

Speaker notes may follow a slide's image. When they do, treat them as the presenter's own plan for the slide: they show what the presenter means to stress, in what order, and how they'll say it.`;

export const directorPrompt = (slides: number, retryError?: string) =>
  retryError
    ? `Your previous answer was invalid: ${retryError}\nReturn the corrected plan for all ${slides} slides.`
    : `Plan this ${slides}-slide deck.`;

/** Per-slide pass for a planned slide: locate exactly what the director chose. */
export const GUIDED_PROMPT = `You prepare one slide of a live presentation for an app that follows the presenter's voice. A director has already chosen what to emphasize on this slide. Find exactly those items, in the same order, and work out how the presenter will talk about them.

For each item return one region:
- id: short kebab-case slug, unique on the slide
- label: 2-5 word name
- description: one sentence describing what it shows
- keywords: 5 to 10 words or short phrases specific to this item. Include spoken forms of numbers ("38 percent", "2.4 million") and the specific nouns visible in it. Always include the name of the heading, section or box the item sits under, because presenters steer by those names ("let's look at education"). Avoid anything that also applies to other items on the slide or to the slide as a whole, because a presenter introducing the slide must not trigger a cue by accident.
- phrases: 3 to 6 things the presenter would actually say on reaching this item, each 3 to 7 words, in natural speech and including paraphrases that don't copy the slide's wording. Include at least one that names the section, such as "let's look at education".
- cue: copy the cue the director gave this item
- box: tight bounding box as fractions of slide width and height: x, y = top-left corner, w, h = size, all between 0 and 1. Measure carefully against the image; include the item's own labels and values. If the slide's exact text boxes are listed and an item is one of them, copy that box exactly instead of measuring.

Any speaker notes are the presenter's own words, so use their phrasing in phrases.`;

const num = (n: number) => n.toFixed(3);

/** What the file itself says about a slide. It costs next to nothing and it's exact, so it goes along with the image. */
export function factsPrompt(facts?: SlideFacts): string {
  if (!facts) return "";
  const shapes = facts.shapes.map((s) => `- "${s.text}" x=${num(s.box.x)} y=${num(s.box.y)} w=${num(s.box.w)} h=${num(s.box.h)}`);
  return [
    facts.notes && `\n\nSpeaker notes:\n${facts.notes}`,
    shapes.length ? `\n\nExact text boxes on this slide:\n${shapes.join("\n")}` : "",
  ].join("");
}

export function guidedPrompt(summary: string, slide: SlidePlan, facts?: SlideFacts, retryError?: string): string {
  if (retryError) return `Your previous answer was invalid: ${retryError}\nReturn corrected JSON for this slide.`;
  const items = slide.emphasis.map((e, i) => `${i + 1}. ${e.target} (cue: ${e.cue}). Why it matters: ${e.why}`).join("\n");
  return `Deck: ${summary}\nThis slide: ${slide.purpose}\n\nItems to find, in order:\n${items}${factsPrompt(facts)}`;
}

/** A cue the presenter drew: they give a rectangle and a label, and everything else is worked out here. */
export const REGION_PROMPT = `You prepare one part of a presentation slide for an app that follows the presenter's voice. The presenter marked this part with a red rectangle and named it. Work out how they will talk about what's inside it.

Return:
- description: one sentence describing what it shows
- keywords: 5 to 10 words or short phrases specific to what's inside the rectangle. Include spoken forms of numbers ("38 percent", "2.4 million"), the specific nouns visible in it, and the name of the heading or section it sits under, because presenters steer by those names. Avoid words that apply to the slide as a whole.
- phrases: 3 to 6 things the presenter would actually say on reaching this part, each 3 to 7 words, in natural speech and including paraphrases that don't copy the slide's wording.

The red rectangle is only a marker and is not part of the slide.`;

export const regionPrompt = (label: string, notes?: string, retryError?: string) =>
  retryError ? `Your previous answer was invalid: ${retryError}\nReturn corrected JSON.` : `The presenter calls the marked part "${label}".${notes ? `\n\nTheir speaker notes for this slide, so use their phrasing:\n${notes}` : ""}`;

export const REGION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["description", "keywords", "phrases"],
  properties: {
    description: { type: "string" },
    keywords: { type: "array", items: { type: "string" } },
    phrases: { type: "array", items: { type: "string" } },
  },
} as const;

/**
 * Text-only pass that runs after a presentation. Given what the presenter said on each slide and
 * the regions that slide contains, extract natural phrases they actually used for each region.
 * These are added to the region's trigger phrases so future runs zoom without exact keyword matches.
 */
export const LEARN_PROMPT = `You improve automated zoom detection for a presentation tool. As someone presents, the tool zooms into whichever part of the current slide they're discussing, matched by keywords and phrases. After each session you receive the transcript of what was said and the slide regions, and extract natural phrases the presenter used that signal they were discussing each region.

Rules:
- Only use words the presenter actually said — pull phrases verbatim from the transcript
- Each phrase must be 3–7 words
- Prefer natural transitions and paraphrases ("here's what we found", "our approach was") over restating slide text verbatim
- Skip a region if the presenter didn't clearly discuss it; return an empty phrases array
- Return 0 to 4 phrases per region`;

export function learnPrompt(
  regions: { id: string; label: string; keywords: string[] }[],
  transcript: string,
): string {
  const list = regions
    .map((r, i) => `${i + 1}. id="${r.id}" label="${r.label}" keywords: ${r.keywords.slice(0, 5).join(", ")}`)
    .join("\n");
  return `Slide regions:\n${list}\n\nTranscript of what the presenter said:\n"${transcript.slice(0, 2000)}"`;
}

export const LEARN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["regions"],
  properties: {
    regions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "phrases"],
        properties: {
          id: { type: "string" },
          phrases: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

export const userPrompt = (retryError?: string) =>
  retryError
    ? `Your previous answer was invalid: ${retryError}\nReturn corrected JSON for this slide.`
    : "Annotate this slide.";

const CUE = { type: "string", enum: CueSchema.options } as const;

export const DIRECTOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "slides"],
  properties: {
    summary: { type: "string" },
    slides: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slide", "purpose", "density", "emphasis"],
        properties: {
          slide: { type: "integer" },
          purpose: { type: "string" },
          density: { type: "string", enum: ["clean", "busy"] },
          emphasis: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["target", "cue", "why"],
              properties: { target: { type: "string" }, cue: CUE, why: { type: "string" } },
            },
          },
        },
      },
    },
  },
} as const;

/** JSON schema for structured outputs: every property required, no extras. */
export const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["regions"],
  properties: {
    regions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "description", "keywords", "phrases", "box"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          description: { type: "string" },
          keywords: { type: "array", items: { type: "string" } },
          phrases: { type: "array", items: { type: "string" } },
          box: {
            type: "object",
            additionalProperties: false,
            required: ["x", "y", "w", "h"],
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              w: { type: "number" },
              h: { type: "number" },
            },
          },
        },
      },
    },
  },
} as const;

export const GUIDED_SCHEMA = {
  ...RESPONSE_SCHEMA,
  properties: {
    regions: {
      type: "array",
      items: {
        ...RESPONSE_SCHEMA.properties.regions.items,
        required: [...RESPONSE_SCHEMA.properties.regions.items.required, "phrases", "cue"],
        properties: {
          ...RESPONSE_SCHEMA.properties.regions.items.properties,
          phrases: { type: "array", items: { type: "string" } },
          cue: CUE,
        },
      },
    },
  },
} as const;

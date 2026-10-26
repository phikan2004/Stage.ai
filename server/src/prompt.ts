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
- box: tight bounding box as fractions of slide width and height: x, y = top-left corner, w, h = size, all between 0 and 1. Measure carefully against the image; include the region's own labels/values.`;

export const userPrompt = (retryError?: string) =>
  retryError
    ? `Your previous answer was invalid: ${retryError}\nReturn corrected JSON for this slide.`
    : "Annotate this slide.";

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
        required: ["id", "label", "description", "keywords", "box"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          description: { type: "string" },
          keywords: { type: "array", items: { type: "string" } },
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

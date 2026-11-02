/** Every tunable threshold and timing in one place. */
export interface ProducerConfig {
  // transcript window
  windowMs: number;
  recencyFloor: number;
  interimWeight: number;
  // matching
  labelWeight: number;
  phraseBonus: number;
  fuzzyThreshold: number;
  saturation: number;
  // restraint
  confidenceThreshold: number;
  margin: number;
  sustainThreshold: number;
  minDwellMs: number;
  noMatchTimeoutMs: number;
  cooldownMs: number;
  // guided slides; worked out per slide by tuneForSlide
  overviewMs: number;
  minHits: number;
  // rendering
  zoomPadding: number;
  maxZoom: number;
  transitionMs: number;
  dimOpacity: number;
}

export const DEFAULT_CONFIG: ProducerConfig = {
  windowMs: 6000,
  recencyFloor: 0.3,
  interimWeight: 0.85,
  labelWeight: 0.6,
  phraseBonus: 1.5,
  fuzzyThreshold: 0.8,
  saturation: 1.2,
  confidenceThreshold: 0.45,
  margin: 0.15,
  sustainThreshold: 0.25,
  minDwellMs: 3000,
  noMatchTimeoutMs: 4000,
  cooldownMs: 800,
  overviewMs: 6000,
  minHits: 2,
  zoomPadding: 0.04,
  maxZoom: 3,
  transitionMs: 450,
  dimOpacity: 0.35,
};

export interface SliderSpec {
  key: keyof ProducerConfig;
  label: string;
  min: number;
  max: number;
  step: number;
  group: "Window" | "Matching" | "Restraint" | "Rendering";
}

export const SLIDERS: SliderSpec[] = [
  { key: "windowMs", label: "Window (ms)", min: 2000, max: 15000, step: 500, group: "Window" },
  { key: "recencyFloor", label: "Oldest-word weight", min: 0, max: 1, step: 0.05, group: "Window" },
  { key: "interimWeight", label: "Interim weight", min: 0, max: 1, step: 0.05, group: "Window" },
  { key: "labelWeight", label: "Label weight", min: 0, max: 1.5, step: 0.05, group: "Matching" },
  { key: "phraseBonus", label: "Phrase bonus", min: 1, max: 3, step: 0.1, group: "Matching" },
  { key: "fuzzyThreshold", label: "Fuzzy threshold", min: 0.6, max: 1, step: 0.01, group: "Matching" },
  { key: "saturation", label: "Score saturation", min: 0.5, max: 5, step: 0.1, group: "Matching" },
  { key: "confidenceThreshold", label: "Confidence", min: 0.1, max: 0.95, step: 0.01, group: "Restraint" },
  { key: "margin", label: "Margin over #2", min: 0, max: 0.6, step: 0.01, group: "Restraint" },
  { key: "sustainThreshold", label: "Sustain score", min: 0.05, max: 0.8, step: 0.01, group: "Restraint" },
  { key: "minDwellMs", label: "Min dwell (ms)", min: 0, max: 8000, step: 250, group: "Restraint" },
  { key: "noMatchTimeoutMs", label: "Zoom-out after (ms)", min: 1000, max: 12000, step: 250, group: "Restraint" },
  { key: "cooldownMs", label: "Cooldown (ms)", min: 0, max: 4000, step: 100, group: "Restraint" },
  { key: "zoomPadding", label: "Padding", min: 0, max: 0.15, step: 0.005, group: "Rendering" },
  { key: "maxZoom", label: "Max zoom", min: 1, max: 3, step: 0.1, group: "Rendering" },
  { key: "transitionMs", label: "Transition (ms)", min: 100, max: 1500, step: 50, group: "Rendering" },
  { key: "dimOpacity", label: "Dim", min: 0, max: 0.8, step: 0.05, group: "Rendering" },
];

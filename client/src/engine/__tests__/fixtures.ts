import type { Region } from "../../../../shared/schema";
import { DEFAULT_CONFIG, type ProducerConfig } from "../config";

export const cfg = (over: Partial<ProducerConfig> = {}): ProducerConfig => ({ ...DEFAULT_CONFIG, ...over });

const box = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };

/** A revenue slide where two regions deliberately share the word "revenue". */
export const REVENUE_SLIDE: Region[] = [
  {
    id: "q4-bar",
    label: "Q4 revenue bar",
    description: "The tallest bar, Q4.",
    keywords: ["Q4", "fourth quarter", "holiday", "record quarter", "peak", "revenue"],
    box,
  },
  {
    id: "yoy-callout",
    label: "Year over year growth",
    description: "+38% YoY callout.",
    keywords: ["38 percent", "growth", "year over year", "YoY", "grew", "revenue"],
    box,
  },
  {
    id: "gross-margin",
    label: "Gross margin",
    description: "Gross margin KPI.",
    keywords: ["gross margin", "margin", "profitability", "61 percent", "costs"],
    box,
  },
];

export const USERS_SLIDE: Region[] = [
  {
    id: "churn-dip",
    label: "Churn dip",
    description: "Dip in March.",
    keywords: ["churn", "dip", "march", "drop", "lost users"],
    box,
  },
  {
    id: "peak-users",
    label: "Peak active users",
    description: "2.4M peak.",
    keywords: ["2.4 million", "peak", "active users", "record", "high"],
    box,
  },
];

/**
 * Generates client/public/sample/sample.pdf (3 chart-heavy 16:9 slides) and
 * sample.regions.json, whose boxes come from the same drawing coordinates,
 * so they are exact. Run: npm run make-sample
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { PRODUCER_FILE_VERSION, type ProducerFile, type Region } from "../shared/schema.ts";

const W = 960;
const H = 540;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "client", "public", "sample");

const INK = "#1F2024";
const MUTED = "#6B6A66";
const RULE = "#E4E1DA";
const ACCENT = "#F4501E";
const BAR = "#9AA7B8";
const PAPER = "#FBFAF8";

type Rect = { x: number; y: number; w: number; h: number };
const frac = (r: Rect) => ({
  x: +(r.x / W).toFixed(4),
  y: +(r.y / H).toFixed(4),
  w: +(r.w / W).toFixed(4),
  h: +(r.h / H).toFixed(4),
});
const pad = (r: Rect, p: number): Rect => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p });

const doc = new PDFDocument({ size: [W, H], margin: 0, autoFirstPage: false, info: { Title: "Producer sample deck" } });
const chunks: Buffer[] = [];
doc.on("data", (c: Buffer) => chunks.push(c));

const slides: Region[][] = [];

function newSlide(title: string, kicker: string) {
  doc.addPage({ size: [W, H], margin: 0 });
  doc.rect(0, 0, W, H).fill(PAPER);
  doc.font("Helvetica").fontSize(10).fillColor(ACCENT).text(kicker.toUpperCase(), 56, 40, { characterSpacing: 1.6 });
  doc.font("Helvetica-Bold").fontSize(30).fillColor(INK).text(title, 56, 58);
  doc.moveTo(56, 104).lineTo(W - 56, 104).lineWidth(0.6).strokeColor(RULE).stroke();
}

function kpi(r: Rect, value: string, label: string, color = INK) {
  doc.roundedRect(r.x, r.y, r.w, r.h, 10).lineWidth(0.8).strokeColor(RULE).stroke();
  doc.font("Helvetica-Bold").fontSize(40).fillColor(color).text(value, r.x + 20, r.y + 18, { width: r.w - 40 });
  doc.font("Helvetica").fontSize(12).fillColor(MUTED).text(label, r.x + 20, r.y + r.h - 34, { width: r.w - 40 });
}

// ---------- Slide 1: revenue bars ----------
{
  newSlide("Revenue by quarter", "FY2026 results");
  const chart: Rect = { x: 56, y: 130, w: 520, h: 360 };
  const base = chart.y + chart.h - 30;
  const values = [4.1, 4.6, 5.2, 7.3];
  const labels = ["Q1", "Q2", "Q3", "Q4"];
  const maxV = 8;
  const plotH = chart.h - 60;
  const bw = 80;
  const gap = (chart.w - 40 - 4 * bw) / 3;
  const bars: Rect[] = [];
  doc.moveTo(chart.x, base).lineTo(chart.x + chart.w, base).lineWidth(0.8).strokeColor(MUTED).stroke();
  values.forEach((v, i) => {
    const h = (v / maxV) * plotH;
    const r = { x: chart.x + 20 + i * (bw + gap), y: base - h, w: bw, h };
    bars.push(r);
    doc.rect(r.x, r.y, r.w, r.h).fill(i === 3 ? ACCENT : BAR);
    doc.font("Helvetica-Bold").fontSize(14).fillColor(INK).text(`$${v}M`, r.x, r.y - 20, { width: bw, align: "center" });
    doc.font("Helvetica").fontSize(12).fillColor(MUTED).text(labels[i], r.x, base + 8, { width: bw, align: "center" });
  });

  const yoy: Rect = { x: 620, y: 130, w: 284, h: 160 };
  kpi(yoy, "+38%", "Year-over-year revenue growth", ACCENT);
  const margin: Rect = { x: 620, y: 310, w: 284, h: 160 };
  kpi(margin, "61%", "Gross margin, up from 54%");

  slides.push([
    {
      id: "revenue-chart",
      label: "Quarterly revenue chart",
      description: "Bar chart of revenue for each quarter of FY2026.",
      keywords: ["revenue", "quarterly", "each quarter", "bar chart", "trend", "steady climb", "fiscal year"],
      box: frac(pad(chart, 4)),
    },
    {
      id: "q1-bar",
      label: "Q1 revenue",
      description: "The smallest bar: $4.1M in the first quarter.",
      keywords: ["Q1", "first quarter", "start of the year", "4.1 million", "slow start", "January"],
      box: frac(pad({ x: bars[0].x, y: bars[0].y - 24, w: bars[0].w, h: bars[0].h + 46 }, 6)),
    },
    {
      id: "q4-bar",
      label: "Q4 record quarter",
      description: "The highlighted Q4 bar at $7.3M, the record quarter.",
      keywords: ["Q4", "fourth quarter", "record quarter", "holiday", "7.3 million", "best quarter", "spike"],
      box: frac(pad({ x: bars[3].x, y: bars[3].y - 24, w: bars[3].w, h: bars[3].h + 46 }, 6)),
    },
    {
      id: "yoy-growth",
      label: "Year-over-year growth",
      description: "Callout showing revenue grew 38% year over year.",
      keywords: ["38 percent", "growth", "year over year", "YoY", "grew", "compared to last year"],
      box: frac(yoy),
    },
    {
      id: "gross-margin",
      label: "Gross margin",
      description: "Gross margin KPI at 61%, up from 54%.",
      keywords: ["gross margin", "margin", "61 percent", "profitability", "costs", "54 percent", "unit economics"],
      box: frac(margin),
    },
  ]);
}

// ---------- Slide 2: active users line ----------
{
  newSlide("Monthly active users", "Engagement");
  const chart: Rect = { x: 56, y: 130, w: 600, h: 360 };
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const vals = [1.2, 1.35, 1.05, 1.3, 1.5, 1.62, 1.75, 1.9, 2.05, 2.2, 2.4, 2.3];
  const left = chart.x + 40;
  const right = chart.x + chart.w - 20;
  const top = chart.y + 30;
  const bottom = chart.y + chart.h - 30;
  const px = (i: number) => left + (i * (right - left)) / (vals.length - 1);
  const py = (v: number) => bottom - ((v - 0.8) / (2.6 - 0.8)) * (bottom - top);

  for (const g of [1, 1.5, 2, 2.5]) {
    doc.moveTo(left, py(g)).lineTo(right, py(g)).lineWidth(0.4).strokeColor(RULE).stroke();
    doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(`${g}M`, chart.x, py(g) - 5, { width: 32, align: "right" });
  }
  months.forEach((m, i) => doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(m, px(i) - 15, bottom + 8, { width: 30, align: "center" }));
  doc.moveTo(px(0), py(vals[0]));
  vals.forEach((v, i) => i && doc.lineTo(px(i), py(v)));
  doc.lineWidth(2.5).strokeColor(INK).stroke();

  // churn dip (March)
  doc.circle(px(2), py(vals[2]), 6).fill(BAR);
  doc.font("Helvetica").fontSize(11).fillColor(MUTED).text("March churn dip", px(2) - 40, py(vals[2]) + 12, { width: 100 });
  const dip: Rect = { x: px(2) - 45, y: py(vals[2]) - 40, w: 110, h: 75 };

  // peak (Nov)
  doc.circle(px(10), py(vals[10]), 7).fill(ACCENT);
  doc.font("Helvetica-Bold").fontSize(22).fillColor(ACCENT).text("2.4M", px(10) - 70, py(vals[10]) - 34, { width: 60, align: "right" });
  const peak: Rect = { x: px(10) - 80, y: py(vals[10]) - 42, w: 100, h: 60 };

  const retention: Rect = { x: 690, y: 130, w: 214, h: 160 };
  kpi(retention, "87%", "90-day retention");
  const dau: Rect = { x: 690, y: 310, w: 214, h: 160 };
  kpi(dau, "41%", "DAU / MAU stickiness");

  slides.push([
    {
      id: "users-chart",
      label: "Monthly active users trend",
      description: "Line chart of monthly active users across the year.",
      keywords: ["active users", "monthly active", "MAU", "user growth", "line chart", "trend", "over the year"],
      box: frac(pad(chart, 4)),
    },
    {
      id: "churn-dip",
      label: "March churn dip",
      description: "A dip in users in March caused by churn.",
      keywords: ["churn", "dip", "March", "drop", "lost users", "decline", "pricing change"],
      box: frac(dip),
    },
    {
      id: "peak-users",
      label: "2.4M peak",
      description: "Peak of 2.4 million monthly active users in November.",
      keywords: ["2.4 million", "peak", "November", "all time high", "record", "high point"],
      box: frac(peak),
    },
    {
      id: "retention",
      label: "90-day retention",
      description: "Retention KPI at 87% over 90 days.",
      keywords: ["retention", "87 percent", "90 day", "stick around", "come back", "retain"],
      box: frac(retention),
    },
    {
      id: "stickiness",
      label: "DAU/MAU stickiness",
      description: "Daily over monthly active users ratio at 41%.",
      keywords: ["stickiness", "DAU", "daily active", "41 percent", "engagement", "every day"],
      box: frac(dau),
    },
  ]);
}

// ---------- Slide 3: regional table ----------
{
  newSlide("Regional breakdown", "Where growth came from");
  const table: Rect = { x: 56, y: 130, w: 560, h: 300 };
  const cols = ["Region", "Revenue", "Growth", "Margin"];
  const colX = [table.x + 16, table.x + 250, table.x + 360, table.x + 460];
  const rows = [
    ["North America", "$9.8M", "+24%", "63%"],
    ["Europe", "$6.1M", "+31%", "58%"],
    ["Asia-Pacific", "$3.9M", "+54%", "55%"],
    ["Rest of world", "$1.4M", "+12%", "49%"],
  ];
  const rowH = 52;
  const headY = table.y + 14;
  cols.forEach((c, i) => doc.font("Helvetica-Bold").fontSize(11).fillColor(MUTED).text(c.toUpperCase(), colX[i], headY, { characterSpacing: 1 }));
  const rowRects: Rect[] = [];
  rows.forEach((r, ri) => {
    const y = table.y + 44 + ri * rowH;
    const rr = { x: table.x, y, w: table.w, h: rowH };
    rowRects.push(rr);
    if (ri === 2) doc.rect(rr.x, rr.y, rr.w, rr.h).fill("#FDEBE4");
    doc.moveTo(table.x, y).lineTo(table.x + table.w, y).lineWidth(0.6).strokeColor(RULE).stroke();
    r.forEach((cell, ci) =>
      doc.font(ci === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(16).fillColor(ri === 2 && ci === 2 ? ACCENT : INK).text(cell, colX[ci], y + 17),
    );
  });
  doc.moveTo(table.x, table.y + 44 + 4 * rowH).lineTo(table.x + table.w, table.y + 44 + 4 * rowH).lineWidth(0.6).strokeColor(RULE).stroke();

  const apac: Rect = { x: 650, y: 130, w: 254, h: 160 };
  kpi(apac, "+54%", "APAC growth, fastest region", ACCENT);
  const total: Rect = { x: 650, y: 310, w: 254, h: 160 };
  kpi(total, "$21.2M", "Total revenue across regions");

  slides.push([
    {
      id: "regional-table",
      label: "Revenue by region table",
      description: "Table of revenue, growth and margin for four regions.",
      keywords: ["region", "regional", "table", "breakdown", "by region", "geography", "markets"],
      box: frac(table),
    },
    {
      id: "north-america",
      label: "North America row",
      description: "North America: $9.8M revenue, +24% growth, 63% margin.",
      keywords: ["North America", "US", "United States", "9.8 million", "largest region", "63 percent"],
      box: frac(rowRects[0]),
    },
    {
      id: "europe",
      label: "Europe row",
      description: "Europe: $6.1M revenue, +31% growth, 58% margin.",
      keywords: ["Europe", "EMEA", "European", "6.1 million", "31 percent", "UK"],
      box: frac(rowRects[1]),
    },
    {
      id: "apac-row",
      label: "Asia-Pacific row",
      description: "Asia-Pacific: $3.9M revenue, +54% growth, 55% margin.",
      keywords: ["Asia Pacific", "APAC", "Asia", "Japan", "3.9 million", "Australia"],
      box: frac(rowRects[2]),
    },
    {
      id: "apac-growth",
      label: "APAC growth callout",
      description: "Callout: APAC grew 54%, the fastest region.",
      keywords: ["54 percent", "fastest growing", "fastest region", "APAC growth", "growth"],
      box: frac(apac),
    },
    {
      id: "total-revenue",
      label: "Total revenue",
      description: "Total revenue of $21.2M across all regions.",
      keywords: ["total", "21.2 million", "overall", "combined", "all regions", "in total"],
      box: frac(total),
    },
  ]);
}

doc.end();
await new Promise<void>((resolve) => doc.on("end", () => resolve()));
const pdf = Buffer.concat(chunks);
const pdfHash = createHash("sha256").update(pdf).digest("hex");

const file: ProducerFile = {
  version: PRODUCER_FILE_VERSION,
  pdfName: "sample.pdf",
  pdfHash,
  slides: slides.map((regions, index) => ({ index, regions })),
};

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "sample.pdf"), pdf);
writeFileSync(join(OUT, "sample.regions.json"), JSON.stringify(file, null, 2) + "\n");
console.log(`wrote ${slides.length} slides, ${pdf.length} bytes, sha256 ${pdfHash.slice(0, 12)}… → ${OUT}`);

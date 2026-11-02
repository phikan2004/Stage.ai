import type { Region } from "../../../shared/schema";
import { arrowFor, calloutBelow } from "../lib/cues";

const pct = (n: number) => `${n * 100}%`;

interface Props {
  region: Region;
  /** padding round the box, in slide fractions */
  pad: number;
  /** aspect ratio of the slide, so arrows aren't stretched */
  aspect: number;
  visible: boolean;
  ease: string;
}

/** Cues drawn on top of the slide. Zoom and Spotlight are handled by the slide's own transform and dimming. */
export default function CueOverlay({ region, pad, aspect, visible, ease }: Props) {
  const { box, cue, label, marks } = region;
  const fade = { opacity: visible ? 1 : 0, transition: `opacity ${ease}` };
  const padded = {
    left: pct(box.x - pad),
    top: pct(box.y - pad),
    width: pct(box.w + 2 * pad),
    height: pct(box.h + 2 * pad),
  };

  if (cue === "outline" || cue === "callout") {
    return (
      <>
        <div className="cue-outline" style={{ ...padded, ...fade }} />
        {cue === "callout" && (
          <div
            className={`cue-callout ${calloutBelow(box) ? "below" : ""}`}
            style={{ left: pct(box.x + box.w / 2), top: pct(calloutBelow(box) ? box.y + box.h + pad : box.y - pad), ...fade }}
          >
            {label}
          </div>
        )}
      </>
    );
  }

  if (cue === "highlight") {
    return (
      <>
        {(marks?.length ? marks : [box]).map((m, i) => (
          <div
            key={i}
            className="cue-mark"
            style={{
              left: pct(m.x),
              top: pct(m.y),
              width: pct(m.w),
              height: pct(m.h),
              transform: `scaleX(${visible ? 1 : 0})`,
              transition: `transform ${ease} ${i * 90}ms`,
            }}
          />
        ))}
      </>
    );
  }

  if (cue === "arrow") {
    const { from, to } = arrowFor(box);
    const point = (p: { x: number; y: number }) => ({ x: p.x * aspect * 100, y: p.y * 100 });
    const a = point(from);
    const b = point(to);
    return (
      <svg className="cue-arrow" viewBox={`0 0 ${aspect * 100} 100`} style={fade}>
        <defs>
          <marker id="cue-arrow-head" markerWidth="4" markerHeight="4" refX="2.6" refY="2" orient="auto">
            <path d="M0,0 L4,2 L0,4 Z" fill="var(--accent)" />
          </marker>
        </defs>
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} markerEnd="url(#cue-arrow-head)" />
      </svg>
    );
  }

  return null;
}

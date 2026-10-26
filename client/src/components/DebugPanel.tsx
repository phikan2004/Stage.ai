import { useState } from "react";
import type { Region } from "../../../shared/schema";
import { SLIDERS, type ProducerConfig } from "../engine/config";
import type { MicLevel } from "../lib/useMicLevel";
import type { SpeechStatus } from "../speech/SpeechSource";
import type { Engine, Snapshot } from "./PresentView";

function browserName(): { name: string; ok: boolean } {
  const nav = navigator as any;
  if (nav.brave) return { name: "Brave (no speech service)", ok: false };
  const brands: string[] = nav.userAgentData?.brands?.map((b: { brand: string }) => b.brand) ?? [];
  if (brands.includes("Google Chrome")) return { name: "Google Chrome", ok: true };
  if (brands.includes("Microsoft Edge")) return { name: "Microsoft Edge", ok: true };
  if (/Arc\//.test(navigator.userAgent)) return { name: "Arc (speech often unavailable)", ok: false };
  if (!("webkitSpeechRecognition" in window) && !("SpeechRecognition" in window)) return { name: "Unsupported browser", ok: false };
  return { name: brands.find((b) => !/Not|Chromium/.test(b)) ?? "Unknown Chromium browser", ok: brands.length === 0 };
}

interface Props {
  snap: Snapshot | null;
  regions: Region[];
  config: ProducerConfig;
  onConfig: (patch: Partial<ProducerConfig> | null) => void;
  auto: boolean;
  outlines: boolean;
  onOutlines: (v: boolean) => void;
  onSimulate: (text: string) => void;
  onClose: () => void;
  mic: { status: SpeechStatus; detail?: string };
  micLevel: MicLevel;
  speechLog: string[];
  engine: Engine | null;
  hasDeepgram: boolean;
  onEngine: (e: Engine) => void;
  voiceCmds: boolean;
  onVoiceCmds: (on: boolean) => void;
}

const fmt = (v: number, step: number) => (step >= 1 ? String(Math.round(v)) : v.toFixed(step < 0.01 ? 3 : 2));
const GROUPS = ["Restraint", "Matching", "Window", "Rendering"] as const;

export default function DebugPanel({
  snap,
  regions,
  config,
  onConfig,
  auto,
  outlines,
  onOutlines,
  onSimulate,
  onClose,
  mic,
  micLevel,
  speechLog,
  engine,
  hasDeepgram,
  onEngine,
  voiceCmds,
  onVoiceCmds,
}: Props) {
  const browser = browserName();
  const [text, setText] = useState("");
  const label = (id: string | null) => regions.find((r) => r.id === id)?.label ?? id ?? "none";
  const scores = snap?.scores ?? regions.map((r) => ({ id: r.id, score: 0, raw: 0 }));

  return (
    <aside className="debug" onKeyDown={(e) => e.stopPropagation()}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="micro">Debug · press D to hide</span>
        <button className="btn small" onClick={onClose}>
          Close
        </button>
      </div>

      <section>
        <div className="micro" style={{ marginBottom: 6 }}>
          Microphone
        </div>
        <div className="engine-switch">
          <button className={`btn small ${engine === "deepgram" ? "on" : ""}`} disabled={!hasDeepgram} onClick={() => onEngine("deepgram")}
            title={hasDeepgram ? "Deepgram Nova-3 streaming" : "Add DEEPGRAM_API_KEY to .env to enable"}>
            Deepgram
          </button>
          <button className={`btn small ${engine === "chrome" ? "on" : ""}`} onClick={() => onEngine("chrome")}>
            Chrome built-in
          </button>
        </div>
        <div className="mic-row">
          <span>Browser</span>
          <span className={browser.ok ? "" : "bad"}>{browser.name}</span>
        </div>
        <div className="mic-row">
          <span>Input</span>
          <span className={micLevel.error ? "bad" : ""}>{micLevel.error ?? micLevel.device ?? "…"}</span>
        </div>
        <div className="level" title="Live input level, independent of speech recognition">
          <i style={{ width: `${micLevel.level * 100}%` }} />
        </div>
        <div className="mic-row">
          <span>Speech</span>
          <span className={mic.status === "error" || mic.status === "unsupported" ? "bad" : ""}>{mic.status}</span>
        </div>
        {mic.detail && (mic.status === "error" || mic.status === "unsupported") && <div className="mic-help">{mic.detail}</div>}
        <pre className="speech-log">{speechLog.length ? speechLog.join("\n") : "no speech events yet"}</pre>
      </section>

      <section>
        <div className="micro" style={{ marginBottom: 6 }}>
          Simulate speech
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onSimulate(text);
            setText("");
          }}
        >
          <input
            className="field"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a phrase, press Enter"
          />
        </form>
      </section>

      <section>
        <div className="micro" style={{ marginBottom: 6 }}>
          Transcript · last {Math.round(config.windowMs / 1000)}s
        </div>
        <div className="transcript">
          {snap?.finals} <span className="interim">{snap?.interim}</span>
          {!snap?.finals && !snap?.interim && <span className="interim">(silence)</span>}
        </div>
      </section>

      <section>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
          <span className={`phase ${snap?.phase ?? "idle"}`}>{auto ? (snap?.phase ?? "idle") : "manual"}</span>
          <span style={{ color: "rgba(255,255,255,.6)" }}>{snap?.regionId ? label(snap.regionId) : ""}</span>
        </div>
        {scores.map((s, i) => (
          <div className="score" key={s.id}>
            <span className={`name ${s.id === snap?.regionId ? "current" : ""}`}>{label(s.id)}</span>
            <span className="val">{s.score.toFixed(2)}</span>
            <div className="bar">
              <i className={i === 0 && s.score > 0 ? "lead" : ""} style={{ width: `${s.score * 100}%` }} />
              <b style={{ left: `${config.confidenceThreshold * 100}%` }} title="confidence threshold" />
            </div>
          </div>
        ))}
        {scores.length > 1 && (
          <div className="micro" style={{ marginTop: 4 }}>
            Lead over #2: {(scores[0].score - scores[1].score).toFixed(2)} (needs {config.margin.toFixed(2)})
          </div>
        )}
      </section>

      <section>
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
          <input type="checkbox" checked={voiceCmds} onChange={(e) => onVoiceCmds(e.target.checked)} />
          Voice commands ("next slide", "go back", "slide 3", "zoom out")
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <input type="checkbox" checked={outlines} onChange={(e) => onOutlines(e.target.checked)} />
          Show region outlines
        </label>
        {GROUPS.map((g) => (
          <details key={g} open={g === "Restraint"}>
            <summary className="micro">{g}</summary>
            {SLIDERS.filter((s) => s.group === g).map((s) => (
              <div className="slider" key={s.key}>
                <span>{s.label}</span>
                <span className="v">{fmt(config[s.key], s.step)}</span>
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={config[s.key]}
                  onChange={(e) => onConfig({ [s.key]: Number(e.target.value) })}
                />
              </div>
            ))}
          </details>
        ))}
        <button className="btn small" style={{ marginTop: 8 }} onClick={() => onConfig(null)}>
          Reset defaults
        </button>
      </section>
    </aside>
  );
}

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_VOICE, PITCH_RANGE, RATE_RANGE, RobotVoiceSchema, type RobotVoice } from "../../../shared/rehearse";
import { englishVoices, robotVoiceSupported, type RobotSpeechSource } from "../speech/RobotSpeechSource";

const VOICE_KEY = "stage.robotVoice";

function savedVoice(): RobotVoice {
  try {
    const parsed = RobotVoiceSchema.safeParse(JSON.parse(localStorage.getItem(VOICE_KEY) ?? "null"));
    return parsed.success ? parsed.data : DEFAULT_VOICE;
  } catch {
    return DEFAULT_VOICE;
  }
}

/** Puts the settings on the robot; it reads them at the start of each line. */
export function tuneRobot(robot: RobotSpeechSource | null, voice: RobotVoice) {
  if (!robot) return;
  robot.rate = voice.rate;
  robot.pitch = voice.pitch;
  robot.voiceName = voice.voice;
}

/** How the robot sounds, remembered in this browser, and the voices it can use here. */
export function useRobotVoice() {
  const [voice, setState] = useState<RobotVoice>(savedVoice);
  const [voices, setVoices] = useState<string[]>([]);
  useEffect(() => {
    if (!robotVoiceSupported()) return;
    // Chrome loads its voice list after the page does.
    const load = () => setVoices(englishVoices());
    load();
    speechSynthesis.addEventListener("voiceschanged", load);
    return () => speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);
  const setVoice = useCallback((v: RobotVoice) => {
    setState(v);
    try {
      localStorage.setItem(VOICE_KEY, JSON.stringify(v));
    } catch {
      /* remembered for this page only */
    }
  }, []);
  return { voice, setVoice, voices };
}

interface Props {
  voice: RobotVoice;
  voices: string[];
  onChange: (v: RobotVoice) => void;
}

/** Speed, pitch and voice. Changes are heard from the robot's next line. */
export default function RobotVoiceControls({ voice, voices, onChange }: Props) {
  return (
    // Keys here adjust the voice; they mustn't also move the presenter's slides.
    <div className="robot-voice" onKeyDown={(e) => e.stopPropagation()}>
      <label>
        <span className="hint">Speed {voice.rate.toFixed(2)}×</span>
        <input type="range" min={RATE_RANGE[0]} max={RATE_RANGE[1]} step={0.05} value={voice.rate} onChange={(e) => onChange({ ...voice, rate: Number(e.target.value) })} />
      </label>
      <label>
        <span className="hint">Pitch {voice.pitch.toFixed(2)}</span>
        <input type="range" min={PITCH_RANGE[0]} max={PITCH_RANGE[1]} step={0.05} value={voice.pitch} onChange={(e) => onChange({ ...voice, pitch: Number(e.target.value) })} />
      </label>
      <label>
        <span className="hint">Voice</span>
        <select className="field" value={voice.voice ?? ""} onChange={(e) => onChange({ ...voice, voice: e.target.value || null })}>
          <option value="">Default</option>
          {voice.voice && !voices.includes(voice.voice) && <option value={voice.voice}>{voice.voice}</option>}
          {voices.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

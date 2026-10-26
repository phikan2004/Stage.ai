import { useEffect, useState } from "react";

export type MicLevel = { level: number; error?: string; device?: string };

/**
 * Live input level (0..1) from the default microphone, independent of speech
 * recognition. If this moves but no words arrive, the mic is fine and the
 * speech service is the problem.
 */
export function useMicLevel(enabled: boolean): MicLevel {
  const [state, setState] = useState<MicLevel>({ level: 0 });

  useEffect(() => {
    if (!enabled) return;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;

    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(s).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        const device = s.getAudioTracks()[0]?.label;
        timer = setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          const rms = Math.sqrt(sum / buf.length);
          setState({ level: Math.min(1, rms * 8), device });
        }, 100);
      })
      .catch((e: Error) => setState({ level: 0, error: `${e.name}: ${e.message}` }));

    return () => {
      cancelled = true;
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
    };
  }, [enabled]);

  return state;
}

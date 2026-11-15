import { useCallback, useState } from "react";
import { DEFAULT_CONFIG, type ProducerConfig } from "../engine/config";

// Bumped when defaults change meaningfully, so stale saved slider values don't mask them.
const KEY = "producer.config.v3";

function load(): ProducerConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable: use defaults */
  }
  return DEFAULT_CONFIG;
}

export function useConfig() {
  const [config, setConfig] = useState<ProducerConfig>(load);
  const update = useCallback((patch: Partial<ProducerConfig> | null) => {
    setConfig((prev) => {
      const next = patch === null ? DEFAULT_CONFIG : { ...prev, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  return [config, update] as const;
}


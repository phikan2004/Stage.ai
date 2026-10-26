import { useEffect, useState } from "react";

/** Hash routes: "#/", "#/m/<matter>", "#/d/<deck>", "#/r/<run>". */
export function useRoute(): string[] {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const on = () => {
      setHash(location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
}

export const go = (path: string) => {
  location.hash = path;
};

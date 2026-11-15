import { useEffect, useState } from "react";

/** Hash routes: "#/" (Decks), "#/demos" (Demos), "#/projects" (Projects), "#/m/<matter>" (one project; "/demo" after it is the same page), "#/d/<deck>", "#/r/<run>", "#/s/<show>", "#/pair/<token>". */
export function useRoute(): string[] {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const on = () => {
      setHash(location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    // The hash can change before this effect runs, and that event is gone by now.
    setHash(location.hash);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
}

export const go = (path: string) => {
  location.hash = path;
};

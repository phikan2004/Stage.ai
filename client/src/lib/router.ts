import { useEffect, useState } from "react";

/** Hash routes: "#/" (Home), "#/decks" (Decks), "#/demos" (Demos), "#/projects" (Projects), "#/m/<matter>" (one project; "/demo" after it is the same page), "#/d/<deck>", "#/r/<run>", "#/s/<show>". */
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

// Whether this tab has moved between pages here, so going back stays inside the app.
let moved = false;
window.addEventListener("hashchange", () => (moved = true));

/** Back to the previous page, or to `fallback` when this page was opened directly. */
export const back = (fallback: string) => (moved ? history.back() : go(fallback));

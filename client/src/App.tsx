import DeckView from "./components/DeckView";
import LibraryView from "./components/LibraryView";
import RunView from "./components/RunView";
import ShowView from "./components/ShowView";
import { Loading, TopBar } from "./components/Chrome";
import { useRoute } from "./lib/router";

export default function App() {
  const [kind, id] = useRoute();
  if (!kind) return <LibraryView tab="home" />;
  if (kind === "decks") return <LibraryView tab="decks" />;
  if (kind === "demos") return <LibraryView tab="demos" />;
  if (kind === "projects") return <LibraryView tab="projects" />;
  if (kind === "m" && id) return <LibraryView tab="projects" projectId={id} />;
  if (kind === "d" && id) return <DeckView key={id} id={id} />;
  if (kind === "r" && id) return <RunView key={id} id={id} />;
  if (kind === "s" && id) return <ShowView key={id} id={id} />;
  return (
    <>
      <TopBar />
      <Loading text="Page not found" />
    </>
  );
}

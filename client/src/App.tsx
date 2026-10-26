import DeckView from "./components/DeckView";
import HomeView from "./components/HomeView";
import MatterView from "./components/MatterView";
import RunView from "./components/RunView";
import { Loading, TopBar } from "./components/Chrome";
import { useRoute } from "./lib/router";

export default function App() {
  const [kind, id] = useRoute();
  if (!kind) return <HomeView />;
  if (kind === "m" && id) return <MatterView key={id} id={id} />;
  if (kind === "d" && id) return <DeckView key={id} id={id} />;
  if (kind === "r" && id) return <RunView key={id} id={id} />;
  return (
    <>
      <TopBar crumbs={[{ label: "Matters", to: "/" }]} />
      <Loading text="Page not found" />
    </>
  );
}

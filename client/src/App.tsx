import { useEffect } from "react";
import DeckView from "./components/DeckView";
import HomeView from "./components/HomeView";
import MatterView from "./components/MatterView";
import RunView from "./components/RunView";
import ShowView from "./components/ShowView";
import { Loading, TopBar } from "./components/Chrome";
import { go, useRoute } from "./lib/router";
import { saveStageToken } from "./lib/stage";

function Pair({ token }: { token: string }) {
  useEffect(() => {
    saveStageToken(token);
    go("/");
    // Setting the hash it already has fires nothing, and this page would stay here.
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, [token]);
  return <Loading text="Pairing…" />;
}

export default function App() {
  const [kind, id] = useRoute();
  if (!kind) return <HomeView />;
  if (kind === "m" && id) return <MatterView key={id} id={id} />;
  if (kind === "d" && id) return <DeckView key={id} id={id} />;
  if (kind === "r" && id) return <RunView key={id} id={id} />;
  if (kind === "s" && id) return <ShowView key={id} id={id} />;
  if (kind === "pair" && id) return <Pair token={id} />;
  return (
    <>
      <TopBar crumbs={[{ label: "Matters", to: "/" }]} />
      <Loading text="Page not found" />
    </>
  );
}

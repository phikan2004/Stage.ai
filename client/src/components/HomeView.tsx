import { useEffect, useState } from "react";
import type { HomeData } from "../../../shared/schema";
import { api } from "../lib/api";
import { createSampleMatter } from "../lib/deck";
import { plural, relTime } from "../lib/format";
import { go } from "../lib/router";
import { Loading, NewMatterButton, TopBar } from "./Chrome";

export default function HomeView() {
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sampleBusy, setSampleBusy] = useState<string | null>(null);

  useEffect(() => {
    api
      .home()
      .then(setData)
      .catch((e) => setError(`The Producer server isn't reachable (${e instanceof Error ? e.message : e}). Start it with npm run dev.`));
  }, []);

  const trySample = async () => {
    try {
      const deckId = await createSampleMatter(setSampleBusy);
      go(`/d/${deckId}`);
    } catch (e) {
      setError(`Couldn't load the sample deck: ${e instanceof Error ? e.message : e}`);
      setSampleBusy(null);
    }
  };

  return (
    <>
      <TopBar>
        <NewMatterButton className="btn small primary">New matter</NewMatterButton>
      </TopBar>
      <main className="page">
        <div className="page-head">
          <div>
            <div className="micro">Workspace</div>
            <h1 className="display">Matters</h1>
          </div>
        </div>

        {error && <div className="banner err">{error}</div>}
        {!data && !error && <Loading />}

        {data && (
          <>
            <div className="cards">
              <NewMatterButton className="card card-new">
                <span className="plus">+</span>
                <span>New matter</span>
                <span className="hint">A home for one project's presentations</span>
              </NewMatterButton>
              {data.matters.map((m) => (
                <a key={m.id} className="card" href={`#/m/${m.id}`}>
                  <div className="card-img">
                    {m.thumbDeckId ? (
                      <img src={api.thumbUrl(m.thumbDeckId, m.updatedAt)} alt="" />
                    ) : (
                      <span className="monogram display">{m.name.slice(0, 1).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="card-body">
                    <div className="card-title">{m.name}</div>
                    <div className="hint">
                      {plural(m.deckCount, "presentation")}
                    </div>
                    <div className="hint">Updated {relTime(m.updatedAt).toLowerCase()}</div>
                  </div>
                </a>
              ))}
            </div>

            {data.matters.length === 0 && (
              <div className="aside-line">
                {sampleBusy ?? (
                  <>
                    New here?{" "}
                    <button className="linkish" onClick={trySample}>
                      Try the sample deck
                    </button>
                    . It ships with hand-checked regions, so you can present right away.
                  </>
                )}
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}

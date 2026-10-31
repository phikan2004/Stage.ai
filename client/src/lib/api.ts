import type {
  DeckDetail,
  DeckPatch,
  DeckPlan,
  DeckRecord,
  DeckUpload,
  RegionDetails,
  HomeData,
  Matter,
  MatterDetail,
  RunDetail,
  RunInput,
} from "../../../shared/schema";

async function json<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

const send = (method: string, body?: unknown, init?: RequestInit): RequestInit => ({
  method,
  headers: body === undefined ? undefined : { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
  ...init,
});

export const api = {
  home: () => fetch("/api/home").then(json<HomeData>),

  createMatter: (name: string) => fetch("/api/matters", send("POST", { name })).then(json<Matter>),
  matter: (id: string) => fetch(`/api/matters/${id}`).then(json<MatterDetail>),
  renameMatter: (id: string, name: string) => fetch(`/api/matters/${id}`, send("PATCH", { name })).then(json<Matter>),
  deleteMatter: (id: string) => fetch(`/api/matters/${id}`, send("DELETE")).then(json<void>),

  /** The PDF goes straight to storage, then the deck is registered with the server. */
  uploadDeck: async (matterId: string, name: string, pdf: ArrayBuffer, pdfHash: string, slideCount: number) => {
    const { deckId, url } = await fetch(`/api/matters/${matterId}/decks/upload`, send("POST", {})).then(json<DeckUpload>);
    const put = await fetch(url, { method: "PUT", headers: { "content-type": "application/pdf" }, body: pdf });
    if (!put.ok) throw new Error(`Couldn't upload the PDF (HTTP ${put.status})`);
    return fetch(`/api/matters/${matterId}/decks`, send("POST", { deckId, name, pdfHash, slideCount })).then(json<DeckRecord>);
  },
  deck: (id: string) => fetch(`/api/decks/${id}`).then(json<DeckDetail>),
  /** keepalive lets a save started during unload finish (bodies up to 64 KB). */
  patchDeck: (id: string, patch: DeckPatch, keepalive = false) =>
    fetch(`/api/decks/${id}`, send("PATCH", patch, { keepalive })).then(json<DeckRecord>),
  planDeck: (id: string, images: string[], signal?: AbortSignal) =>
    fetch(`/api/decks/${id}/plan`, send("POST", { images }, { signal })).then(json<DeckPlan>),
  describeRegion: (deckId: string, slideIndex: number, label: string, image: string) =>
    fetch("/api/analyze/region", send("POST", { image, label, deckId, slideIndex })).then(json<RegionDetails>),
  deleteDeck: (id: string) => fetch(`/api/decks/${id}`, send("DELETE")).then(json<void>),
  deckPdf: async (id: string) => {
    const res = await fetch(`/api/decks/${id}/pdf`);
    if (!res.ok) throw new Error(`Couldn't load the PDF (HTTP ${res.status})`);
    return res.arrayBuffer();
  },
  putThumb: (id: string, jpeg: Blob) =>
    fetch(`/api/decks/${id}/thumb`, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: jpeg }).then(json<void>),
  thumbUrl: (id: string, version?: number) => `/api/decks/${id}/thumb${version ? `?v=${version}` : ""}`,

  saveRun: (run: RunInput) => fetch("/api/runs", send("POST", run)).then(json<{ id: string }>),
  /** For page unload, when a normal fetch would be cancelled. */
  beaconRun: (run: RunInput) => navigator.sendBeacon("/api/runs", new Blob([JSON.stringify(run)], { type: "application/json" })),
  run: (id: string) => fetch(`/api/runs/${id}`).then(json<RunDetail>),
  deleteRun: (id: string) => fetch(`/api/runs/${id}`, send("DELETE")).then(json<void>),
};

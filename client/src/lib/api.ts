import type {
  Cue,
  DeckDetail,
  DeckFormat,
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
  Show,
  ShowPatch,
  SlideFacts,
} from "../../../shared/schema";
import type { CueChatReply, CueChatRequest, DeckFeedbackReply, DeckFeedbackRequest, DeckScript, ShowFeedbackReply, ShowFeedbackRequest, ShowScript } from "../../../shared/rehearse";

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

const MIME: Record<DeckFormat, string> = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const api = {
  home: () => fetch("/api/home").then(json<HomeData>),

  allShows: () => fetch("/api/shows").then(json<Show[]>),
  shows: (matterId: string) => fetch(`/api/matters/${matterId}/shows`).then(json<Show[]>),
  createShow: (matterId: string, name: string) => fetch(`/api/matters/${matterId}/shows`, send("POST", { name })).then(json<Show>),
  show: (id: string) => fetch(`/api/shows/${id}`).then(json<Show>),
  patchShow: (id: string, patch: ShowPatch) => fetch(`/api/shows/${id}`, send("PATCH", patch)).then(json<Show>),
  showScript: (id: string) => fetch(`/api/shows/${id}/rehearse/script`, send("POST", {})).then(json<ShowScript>),
  showFeedback: (id: string, body: ShowFeedbackRequest) => fetch(`/api/shows/${id}/rehearse/feedback`, send("POST", body)).then(json<ShowFeedbackReply>),
  deleteShow: (id: string) => fetch(`/api/shows/${id}`, send("DELETE")).then(json<void>),

  createMatter: (name: string, solo = false) => fetch("/api/matters", send("POST", { name, solo })).then(json<Matter>),
  matter: (id: string) => fetch(`/api/matters/${id}`).then(json<MatterDetail>),
  renameMatter: (id: string, name: string) => fetch(`/api/matters/${id}`, send("PATCH", { name })).then(json<Matter>),
  deleteMatter: (id: string) => fetch(`/api/matters/${id}`, send("DELETE")).then(json<void>),

  /** The file goes straight to storage, then the deck is registered with the server. */
  uploadDeck: async (matterId: string, name: string, format: DeckFormat, bytes: ArrayBuffer, pdfHash: string, slideCount: number) => {
    const { deckId, url } = await fetch(`/api/matters/${matterId}/decks/upload`, send("POST", { format })).then(json<DeckUpload>);
    const put = await fetch(url, { method: "PUT", headers: { "content-type": MIME[format] }, body: bytes });
    if (!put.ok) throw new Error(`Couldn't upload the presentation (HTTP ${put.status})`);
    return fetch(`/api/matters/${matterId}/decks`, send("POST", { deckId, name, format, pdfHash, slideCount })).then(json<DeckRecord>);
  },
  deck: (id: string) => fetch(`/api/decks/${id}`).then(json<DeckDetail>),
  /** keepalive lets a save started during unload finish (bodies up to 64 KB). */
  patchDeck: (id: string, patch: DeckPatch, keepalive = false) =>
    fetch(`/api/decks/${id}`, send("PATCH", patch, { keepalive })).then(json<DeckRecord>),
  planDeck: (id: string, images: string[], facts: SlideFacts[] | undefined, signal?: AbortSignal) =>
    fetch(`/api/decks/${id}/plan`, send("POST", { images, facts }, { signal })).then(json<DeckPlan>),
  describeRegion: (deckId: string, slideIndex: number, label: string, cue: Cue, image: string, notes?: string) =>
    fetch("/api/analyze/region", send("POST", { image, label, cue, deckId, slideIndex, notes })).then(json<RegionDetails>),
  cueChat: (id: string, body: CueChatRequest) => fetch(`/api/decks/${id}/cues/chat`, send("POST", body)).then(json<CueChatReply>),
  deckScript: (id: string, notes?: string[]) => fetch(`/api/decks/${id}/rehearse/script`, send("POST", { notes })).then(json<DeckScript>),
  deckFeedback: (id: string, body: DeckFeedbackRequest) => fetch(`/api/decks/${id}/rehearse/feedback`, send("POST", body)).then(json<DeckFeedbackReply>),
  deleteDeck: (id: string) => fetch(`/api/decks/${id}`, send("DELETE")).then(json<void>),
  deckFile: async (id: string) => {
    const res = await fetch(`/api/decks/${id}/file`);
    if (!res.ok) throw new Error(`Couldn't load the presentation (HTTP ${res.status})`);
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

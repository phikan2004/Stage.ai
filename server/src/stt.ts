/**
 * Live speech goes straight from the browser to Deepgram. The server only mints a short-lived token and builds the
 * streaming url, so DEEPGRAM_API_KEY never leaves it. (Serverless hosts cut long-lived sockets, so relaying the audio
 * through here would drop speech mid-presentation; a Deepgram token only has to be valid when the socket opens.)
 */
export const DEEPGRAM_MODEL = "nova-3";

const MAX_KEYTERMS = 50;
const TOKEN_TTL_S = 60;

export class SttError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function deepgramUrl(keyterms: string[]): string {
  const params = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || DEEPGRAM_MODEL,
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    // Finalize a phrase after 300 ms of silence instead of waiting longer.
    endpointing: "300",
  });
  for (const term of keyterms.slice(0, MAX_KEYTERMS)) {
    if (term.trim()) params.append("keyterm", term.trim().slice(0, 60));
  }
  return `wss://api.deepgram.com/v1/listen?${params}`;
}

/** A streaming url plus a token that's good for opening one socket to it. */
export async function createSttSession(keyterms: string[]): Promise<{ url: string; token: string }> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new SttError("DEEPGRAM_API_KEY is not set on the server", 503);
  const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    headers: { authorization: `Token ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl_seconds: TOKEN_TTL_S }),
  });
  if (res.status === 401) throw new SttError("Deepgram rejected the API key", 503);
  if (res.status === 403) {
    throw new SttError("This Deepgram key can't create tokens. Use a key with the Member role or higher.", 503);
  }
  if (!res.ok) throw new SttError(`Deepgram error ${res.status}`, 502);
  const { access_token: token } = (await res.json()) as { access_token: string };
  return { url: deepgramUrl(keyterms), token };
}

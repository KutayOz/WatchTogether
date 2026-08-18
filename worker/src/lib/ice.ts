/**
 * ICE server configuration for WebRTC.
 *
 * Ported from SessionService.cs:123-312. The shape is unchanged — the frontend
 * feeds it straight into RTCPeerConnection — but `urls` stays a single string
 * per entry, matching IceServer.cs, so Cloudflare's array response is flattened
 * into one entry per URL.
 */

export interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

/** Always present, and the only thing left if TURN minting fails. */
const STUN_SERVERS: IceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const CLOUDFLARE_TURN_ENDPOINT = "https://rtc.live.cloudflare.com/v1/turn/keys";
const DEFAULT_TTL_SECONDS = 86_400;
const MINT_TIMEOUT_MS = 5_000;

interface CloudflareIceEntry {
  urls?: string[] | string;
  username?: string;
  credential?: string;
}

/**
 * Cloudflare has shipped `iceServers` both as a single object and as an array
 * of them, and `urls` as either a string or an array. Accepting all four
 * combinations costs a few lines and removes a whole class of silent breakage
 * — a shape change here degrades to STUN-only, which looks exactly like
 * success until somebody behind symmetric NAT cannot connect.
 */
interface CloudflareIceResponse {
  iceServers?: CloudflareIceEntry | CloudflareIceEntry[];
}

export function normalizeEntries(body: CloudflareIceResponse): IceServer[] {
  const entries = body.iceServers
    ? Array.isArray(body.iceServers)
      ? body.iceServers
      : [body.iceServers]
    : [];

  return entries.flatMap((entry) => {
    const urls = typeof entry.urls === "string" ? [entry.urls] : (entry.urls ?? []);
    // One URL per entry: IceServer.urls is a single string, matching what the
    // frontend feeds to RTCPeerConnection.
    return urls.map((url) => ({
      urls: url,
      username: entry.username,
      credential: entry.credential,
    }));
  });
}

/**
 * The URLs we are about to hand a client, as one line.
 *
 * Pure and exported so the "no credentials" property is a test rather than a
 * reviewer's memory — this string goes to the Worker log.
 */
export function summarizeIceServers(servers: IceServer[]): string {
  return servers.map((s) => s.urls).join(" ");
}

/**
 * Mint short-lived TURN credentials.
 *
 * Degrades to STUN-only on any failure rather than erroring: a session with no
 * TURN still connects for the majority of peers, whereas a 500 here fails
 * every call outright. Symmetric NAT is the case that suffers.
 */
export async function getIceServers(env: Env): Promise<IceServer[]> {
  const keyId = env.CLOUDFLARE_TURN_KEY_ID;
  const apiToken = env.CLOUDFLARE_TURN_API_TOKEN;

  if (!keyId || !apiToken) return STUN_SERVERS;

  const ttl = Number(env.CLOUDFLARE_TURN_TTL_SECONDS) || DEFAULT_TTL_SECONDS;

  try {
    const response = await fetch(
      `${CLOUDFLARE_TURN_ENDPOINT}/${keyId}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl }),
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      console.warn(`[ice] Cloudflare TURN mint failed: HTTP ${response.status}`);
      return STUN_SERVERS;
    }

    const body = await response.json<CloudflareIceResponse>();
    const minted = normalizeEntries(body);

    if (minted.length === 0) {
      // Previously a silent return, which made a shape mismatch invisible:
      // the endpoint answered 200, no warning was logged, and calls quietly
      // lost their relay. Log the keys — never the values, which are live
      // credentials.
      console.warn(
        `[ice] Cloudflare TURN returned no usable servers; response keys: ${Object.keys(body).join(",")}`,
      );
      return STUN_SERVERS;
    }

    const servers = [...STUN_SERVERS, ...minted];
    // So a support case is answerable from the Worker log alone. The question
    // that mattered in the reported TURN/TCP session was "was a UDP relay URL
    // even offered?" — and only this side knows what Cloudflare minted.
    // URLs only; the credentials that ride alongside them never get logged.
    console.info(`[ice] offering ${summarizeIceServers(servers)}`);
    return servers;
  } catch (error) {
    console.warn("[ice] Cloudflare TURN mint error", error);
    return STUN_SERVERS;
  }
}

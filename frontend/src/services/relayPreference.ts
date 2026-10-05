/**
 * Force this browser's media onto TURN over TCP/TLS, for a network that
 * throttles UDP.
 *
 * Some networks — student-housing LANs are the usual offender — police UDP to a
 * trickle while leaving TCP alone. WebRTC cannot tell that from a slow link: a
 * captured session ran a movie share into such a network with the peer's speed
 * test reading 10+ Mbps, and the congestion controller still settled at
 * 150-200 kbps with 10-16 % loss bursts and multi-second RTT spikes, the encoder
 * pinned at its 30 kbps floor and the picture at 3-8 fps. Nothing on the sending
 * side can fix that, because the damage is on the receiver's own access link.
 *
 * Opt-in and per browser, because it is a trade, not an upgrade: TURN over TCP
 * adds latency and head-of-line blocking that a healthy UDP path never pays.
 * The person on the throttled network opens their session link with
 * `?relay=tls` (or `?relay=tcp`), the choice is remembered in localStorage so a
 * refresh or rejoin keeps it, and `?relay=off` forgets it.
 *
 * `tls` keeps only `turns:` URLs (TLS, normally on 443), which a network cannot
 * tell from HTTPS. `tcp` also allows plain `turn:...?transport=tcp`, whose ICE
 * priority is higher than TLS — so when both work, ICE picks plain TCP.
 */

export type RelayMode = 'tcp' | 'tls';

export const RELAY_SETTING_KEY = 'wt:relay';

export function parseRelayMode(value: string | null | undefined): RelayMode | null {
  return value === 'tcp' || value === 'tls' ? value : null;
}

/** Whether a TURN URL keeps the browser's own leg of the path off UDP. */
export function isRelayUrlAllowed(url: string, mode: RelayMode): boolean {
  if (/^turns:/i.test(url)) return true;
  if (mode === 'tls') return false;
  return /^turn:/i.test(url) && /[?&]transport=tcp(?:&|$)/i.test(url);
}

/**
 * The RTCConfiguration for a relay mode, or the input unchanged.
 *
 * Unchanged — not an empty server list under a 'relay' policy — when no URL
 * qualifies, e.g. the Worker's TURN mint failed and only STUN came back. A
 * relay-only connection with nothing to relay through never connects at all,
 * which is strictly worse than the throttled path it was meant to escape.
 */
export function applyRelayMode(config: RTCConfiguration, mode: RelayMode | null): RTCConfiguration {
  if (!mode) return config;
  const iceServers: RTCIceServer[] = [];
  for (const server of config.iceServers ?? []) {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
      .filter((url) => isRelayUrlAllowed(url, mode));
    if (urls.length > 0) {
      iceServers.push({ ...server, urls: urls.length === 1 ? urls[0] : urls });
    }
  }
  if (iceServers.length === 0) return config;
  return { ...config, iceServers, iceTransportPolicy: 'relay' };
}

/**
 * Remember `?relay=` from the URL the app was opened with.
 *
 * Read once at boot rather than when the peer connection is built, because by
 * then the router may already have replaced the URL. Never throws: storage can
 * be absent or blocked — merely reading `window.localStorage` throws when site
 * data is blocked, hence a getter called inside the try — and a broken
 * preference must not stop the app loading.
 */
export function persistRelayModeFromUrl(
  search: string,
  getStorage: () => Pick<Storage, 'setItem' | 'removeItem'> | undefined,
): void {
  try {
    const raw = new URLSearchParams(search).get('relay');
    if (raw === null) return;
    const storage = getStorage();
    if (!storage) return;
    const mode = parseRelayMode(raw.toLowerCase());
    if (mode) storage.setItem(RELAY_SETTING_KEY, mode);
    else storage.removeItem(RELAY_SETTING_KEY);
  } catch {
    // Storage blocked — keep whatever was there.
  }
}

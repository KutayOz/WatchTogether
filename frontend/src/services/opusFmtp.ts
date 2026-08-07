/**
 * Opus tuning that the WebRTC APIs do not expose.
 *
 * `maxBitrate` on an encoding caps the sender, but DTX — discontinuous
 * transmission, where silence costs essentially nothing instead of a steady
 * stream of encoded room tone — has no RTCRtpEncodingParameters field in any
 * browser. The only way to ask for it is the codec's own fmtp line.
 *
 * That matters here more than it would in a meeting app: this is a CO-WATCHING
 * app, so for most of a session both people are silent, watching something.
 * A continuously-encoded mic is paying full price to transmit nothing.
 *
 * This is the only SDP rewriting in the codebase and it is deliberately
 * surgical — it edits the `a=fmtp:` line belonging to the Opus payload type on
 * audio m-sections, and touches nothing else. A regex over the whole SDP would
 * be the usual way to get this wrong.
 */

/**
 * The Worker drops any signalling frame carrying an SDP over 30,000 characters
 * — silently, with no error frame and no close code (see
 * worker/src/lib/protocol.ts MAX_SDP_LENGTH and SessionRoom.webSocketMessage).
 * Anything that GROWS the SDP has to be measured against that, so this module
 * exports the threshold rather than hiding it.
 */
export const SDP_WARN_LENGTH = 24_000;

export interface OpusOptions {
  /** Silence costs ~nothing. The whole point on a co-watching call. */
  dtx?: boolean;
  /** Stereo matters for film audio; voice does not need it. */
  stereo?: boolean;
  /** Target average, bps. Opus treats this as guidance, not a hard cap. */
  maxAverageBitrate?: number;
  /** In-band FEC — cheap loss resilience for speech. */
  fec?: boolean;
}

/** Payload types for Opus, read from the m-section's rtpmap lines. */
function opusPayloadTypes(lines: string[]): Set<string> {
  const types = new Set<string>();
  for (const line of lines) {
    // e.g. "a=rtpmap:111 opus/48000/2"
    const match = /^a=rtpmap:(\d+)\s+opus\/\d+/i.exec(line);
    if (match) types.add(match[1]);
  }
  return types;
}

/** Merge parameters into an existing `a=fmtp:` body, preserving what is there. */
function mergeFmtp(body: string, params: Record<string, string>): string {
  const entries = new Map<string, string>();
  for (const part of body.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) entries.set(trimmed, '');
    else entries.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  // Ours win: the browser's defaults are exactly what we are here to override.
  for (const [key, value] of Object.entries(params)) entries.set(key, value);

  return [...entries]
    .map(([key, value]) => (value === '' ? key : `${key}=${value}`))
    .join(';');
}

/**
 * Apply Opus options to every audio m-section in an SDP.
 *
 * Returns the SDP unchanged when there is no Opus to configure, so a caller can
 * always use the result without checking. Never throws: a malformed SDP is
 * returned as-is rather than breaking negotiation over an audio tweak.
 */
export function applyOpusOptions(sdp: string, options: OpusOptions): string {
  if (!sdp) return sdp;

  const params: Record<string, string> = {};
  if (options.dtx !== undefined) params.usedtx = options.dtx ? '1' : '0';
  if (options.stereo !== undefined) {
    params.stereo = options.stereo ? '1' : '0';
    // Tell the far end what to expect from us as well as what we accept.
    params['sprop-stereo'] = options.stereo ? '1' : '0';
  }
  if (options.fec !== undefined) params.useinbandfec = options.fec ? '1' : '0';
  if (options.maxAverageBitrate !== undefined) {
    params.maxaveragebitrate = String(Math.round(options.maxAverageBitrate));
  }
  if (Object.keys(params).length === 0) return sdp;

  try {
    // Split on line boundaries but remember the ending, because SDP is
    // CRLF-delimited on the wire and rejoining with \n alone can break parsers.
    const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
    const lines = sdp.split(/\r\n|\n/);

    // Walk m-sections so a video codec that happens to share a payload number
    // with audio Opus is never touched.
    let sectionStart = -1;
    let isAudio = false;
    const sections: Array<{ start: number; end: number; audio: boolean }> = [];

    lines.forEach((line, index) => {
      if (!line.startsWith('m=')) return;
      if (sectionStart !== -1) sections.push({ start: sectionStart, end: index, audio: isAudio });
      sectionStart = index;
      isAudio = line.startsWith('m=audio');
    });
    if (sectionStart !== -1) {
      sections.push({ start: sectionStart, end: lines.length, audio: isAudio });
    }

    // Rebuilt rather than spliced in place: adding an fmtp line changes the
    // length of a section, which would invalidate every later section's
    // recorded offsets.
    const out: string[] = [];
    // Anything before the first m= line (the session-level block) is untouched.
    const firstSection = sections[0]?.start ?? lines.length;
    out.push(...lines.slice(0, firstSection));

    for (const section of sections) {
      const body = lines.slice(section.start, section.end);
      const payloads = section.audio ? opusPayloadTypes(body) : new Set<string>();

      for (const payload of payloads) {
        const prefix = `a=fmtp:${payload} `;
        const fmtpIndex = body.findIndex((l) => l.startsWith(prefix));
        if (fmtpIndex !== -1) {
          body[fmtpIndex] = prefix + mergeFmtp(body[fmtpIndex].slice(prefix.length), params);
          continue;
        }
        // No fmtp line yet — add one directly after the rtpmap, which is where
        // every implementation expects to find it.
        const rtpmapIndex = body.findIndex((l) =>
          new RegExp(`^a=rtpmap:${payload}\\s+opus/`, 'i').test(l),
        );
        if (rtpmapIndex === -1) continue;
        body.splice(rtpmapIndex + 1, 0, prefix + mergeFmtp('', params));
      }

      out.push(...body);
    }

    return out.join(eol);
  } catch {
    // An audio parameter is never worth failing a negotiation over.
    return sdp;
  }
}

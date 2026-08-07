import { describe, expect, it } from 'vitest';
import { applyOpusOptions } from './opusFmtp';

/**
 * The only SDP rewriting in the codebase.
 *
 * DTX has no RTCRtpEncodingParameters field in any browser, so the fmtp line is
 * the only way to ask for it — and on a co-watching call, where both people are
 * silent for most of a session, a mic that transmits continuous encoded room
 * tone is paying full price to say nothing.
 *
 * The risk being tested for is collateral damage: a regex over the whole SDP is
 * the usual way this goes wrong.
 */

const SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:96 VP9/90000',
  'a=fmtp:96 profile-id=0',
].join('\r\n');

/** The fmtp body for a payload type, as a key/value map. */
function fmtp(sdp: string, payload: string): Record<string, string> {
  const line = sdp.split(/\r\n|\n/).find((l) => l.startsWith(`a=fmtp:${payload} `));
  if (!line) throw new Error(`no fmtp for payload ${payload}`);
  const out: Record<string, string> = {};
  for (const part of line.slice(`a=fmtp:${payload} `.length).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) out[part] = '';
    else out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

describe('applyOpusOptions', () => {
  it('turns DTX on for the Opus payload', () => {
    expect(fmtp(applyOpusOptions(SDP, { dtx: true }), '111').usedtx).toBe('1');
  });

  it('preserves parameters the browser already set', () => {
    // minptime is the browser's; clobbering the whole line would drop it.
    const out = fmtp(applyOpusOptions(SDP, { dtx: true }), '111');
    expect(out.minptime).toBe('10');
    expect(out.useinbandfec).toBe('1');
  });

  it('leaves the video section completely alone', () => {
    // A regex over the whole SDP is how a "profile-id=0" on VP9 ends up with
    // usedtx appended to it.
    const tuned = applyOpusOptions(SDP, { dtx: true, stereo: true });
    expect(fmtp(tuned, '96')).toEqual({ 'profile-id': '0' });
  });

  it('leaves other audio codecs in the same section alone', () => {
    // RED shares the m-section with Opus and must not be touched.
    const tuned = applyOpusOptions(SDP, { dtx: true });
    expect(tuned).toContain('a=fmtp:63 111/111');
  });

  it('sets stereo on both directions', () => {
    const out = fmtp(applyOpusOptions(SDP, { stereo: true }), '111');
    expect(out.stereo).toBe('1');
    expect(out['sprop-stereo']).toBe('1');
  });

  it('adds an fmtp line when the browser did not emit one', () => {
    const bare = SDP.replace('a=fmtp:111 minptime=10;useinbandfec=1\r\n', '');
    const tuned = applyOpusOptions(bare, { dtx: true });
    expect(fmtp(tuned, '111').usedtx).toBe('1');
    // Directly after its rtpmap, where parsers expect it.
    const lines = tuned.split('\r\n');
    expect(lines[lines.findIndex((l) => l.startsWith('a=rtpmap:111 opus')) + 1]).toContain(
      'a=fmtp:111',
    );
  });

  it('preserves CRLF line endings', () => {
    // SDP is CRLF on the wire; rejoining with \n alone breaks strict parsers.
    const tuned = applyOpusOptions(SDP, { dtx: true });
    expect(tuned).toContain('\r\n');
    expect(tuned.split('\r\n').length).toBe(SDP.split('\r\n').length);
  });

  it('returns the input untouched when there is no Opus', () => {
    const videoOnly = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 VP9/90000'].join(
      '\r\n',
    );
    expect(applyOpusOptions(videoOnly, { dtx: true })).toBe(videoOnly);
  });

  it('returns the input untouched when no options are given', () => {
    expect(applyOpusOptions(SDP, {})).toBe(SDP);
  });

  it('barely grows the SDP', () => {
    // The worker DROPS frames whose SDP exceeds 30,000 chars — silently, with
    // no error and no close code. This is the only change that grows it.
    const grown = applyOpusOptions(SDP, {
      dtx: true,
      fec: true,
      stereo: true,
      maxAverageBitrate: 96_000,
    }).length;
    expect(grown - SDP.length).toBeLessThan(100);
  });

  it('survives a malformed SDP rather than breaking negotiation', () => {
    const junk = 'not an sdp at all';
    expect(applyOpusOptions(junk, { dtx: true })).toBe(junk);
    expect(applyOpusOptions('', { dtx: true })).toBe('');
  });
});

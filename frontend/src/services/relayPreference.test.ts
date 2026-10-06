import { describe, expect, it, vi } from 'vitest';
import {
  RELAY_SETTING_KEY,
  applyRelayMode,
  isRelayUrlAllowed,
  parseRelayMode,
  persistRelayModeFromUrl,
} from './relayPreference';

/** The list the Worker actually hands out: Cloudflare TURN, one URL per entry. */
const CLOUDFLARE: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'turn:turn.cloudflare.com:3478?transport=udp', username: 'u', credential: 'c' },
  { urls: 'turn:turn.cloudflare.com:3478?transport=tcp', username: 'u', credential: 'c' },
  { urls: 'turns:turn.cloudflare.com:5349?transport=tcp', username: 'u', credential: 'c' },
  { urls: 'turn:turn.cloudflare.com:443?transport=udp', username: 'u', credential: 'c' },
  { urls: 'turn:turn.cloudflare.com:80?transport=tcp', username: 'u', credential: 'c' },
  { urls: 'turns:turn.cloudflare.com:443?transport=tcp', username: 'u', credential: 'c' },
];

const BASE: RTCConfiguration = { iceServers: CLOUDFLARE, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' };

const urlsOf = (config: RTCConfiguration) => (config.iceServers ?? []).flatMap((s) => [s.urls].flat());

describe('parseRelayMode', () => {
  it('accepts only the two modes', () => {
    expect(parseRelayMode('tcp')).toBe('tcp');
    expect(parseRelayMode('tls')).toBe('tls');
    expect(parseRelayMode('udp')).toBeNull();
    expect(parseRelayMode('')).toBeNull();
    expect(parseRelayMode(null)).toBeNull();
  });
});

describe('isRelayUrlAllowed', () => {
  it('never lets a UDP leg through', () => {
    expect(isRelayUrlAllowed('turn:turn.cloudflare.com:3478?transport=udp', 'tcp')).toBe(false);
    expect(isRelayUrlAllowed('turn:turn.cloudflare.com:3478', 'tcp')).toBe(false);
    expect(isRelayUrlAllowed('stun:stun.cloudflare.com:3478', 'tcp')).toBe(false);
  });

  it('tls keeps only turns:', () => {
    expect(isRelayUrlAllowed('turns:turn.cloudflare.com:443?transport=tcp', 'tls')).toBe(true);
    expect(isRelayUrlAllowed('turn:turn.cloudflare.com:80?transport=tcp', 'tls')).toBe(false);
  });

  it('does not mistake a longer transport name for tcp', () => {
    expect(isRelayUrlAllowed('turn:example.com:3478?transport=tcpx', 'tcp')).toBe(false);
  });
});

describe('applyRelayMode', () => {
  it('is the identity with no mode', () => {
    expect(applyRelayMode(BASE, null)).toBe(BASE);
  });

  it('tcp: relay-only over every TCP and TLS TURN URL, credentials kept', () => {
    const config = applyRelayMode(BASE, 'tcp');
    expect(config.iceTransportPolicy).toBe('relay');
    expect(urlsOf(config)).toEqual([
      'turn:turn.cloudflare.com:3478?transport=tcp',
      'turns:turn.cloudflare.com:5349?transport=tcp',
      'turn:turn.cloudflare.com:80?transport=tcp',
      'turns:turn.cloudflare.com:443?transport=tcp',
    ]);
    expect(config.iceServers?.every((s) => s.username === 'u' && s.credential === 'c')).toBe(true);
    expect(config.bundlePolicy).toBe('max-bundle');
  });

  it('tls: relay-only over turns: alone', () => {
    const config = applyRelayMode(BASE, 'tls');
    expect(config.iceTransportPolicy).toBe('relay');
    expect(urlsOf(config)).toEqual([
      'turns:turn.cloudflare.com:5349?transport=tcp',
      'turns:turn.cloudflare.com:443?transport=tcp',
    ]);
  });

  it('filters inside a multi-URL entry too', () => {
    const config = applyRelayMode(
      { iceServers: [{ urls: ['turn:a:3478?transport=udp', 'turns:a:443?transport=tcp'], username: 'u', credential: 'c' }] },
      'tcp',
    );
    expect(config.iceServers).toEqual([{ urls: 'turns:a:443?transport=tcp', username: 'u', credential: 'c' }]);
  });

  it('leaves the config alone when nothing could relay — a dead connection is worse than a slow one', () => {
    const stunOnly: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    expect(applyRelayMode(stunOnly, 'tcp')).toBe(stunOnly);
    expect(applyRelayMode(stunOnly, 'tcp').iceTransportPolicy).toBeUndefined();
  });
});

describe('persistRelayModeFromUrl', () => {
  const storage = () => ({ setItem: vi.fn(), removeItem: vi.fn() });

  it('remembers a valid mode', () => {
    const s = storage();
    persistRelayModeFromUrl('?relay=tls', () => s);
    expect(s.setItem).toHaveBeenCalledWith(RELAY_SETTING_KEY, 'tls');
  });

  it('is case-insensitive', () => {
    const s = storage();
    persistRelayModeFromUrl('?relay=TCP', () => s);
    expect(s.setItem).toHaveBeenCalledWith(RELAY_SETTING_KEY, 'tcp');
  });

  it('forgets on any other value', () => {
    const s = storage();
    persistRelayModeFromUrl('?relay=off', () => s);
    expect(s.removeItem).toHaveBeenCalledWith(RELAY_SETTING_KEY);
    expect(s.setItem).not.toHaveBeenCalled();
  });

  it('does nothing without the parameter', () => {
    const s = storage();
    persistRelayModeFromUrl('?invite=abc', () => s);
    expect(s.setItem).not.toHaveBeenCalled();
    expect(s.removeItem).not.toHaveBeenCalled();
  });

  it('survives storage that throws', () => {
    const s = { setItem: vi.fn(() => { throw new Error('blocked'); }), removeItem: vi.fn() };
    expect(() => persistRelayModeFromUrl('?relay=tcp', () => s)).not.toThrow();
  });

  it('survives no storage at all', () => {
    expect(() => persistRelayModeFromUrl('?relay=tcp', () => undefined)).not.toThrow();
  });

  it('survives a storage getter that throws, as window.localStorage does when site data is blocked', () => {
    expect(() => persistRelayModeFromUrl('?relay=tcp', () => { throw new DOMException('denied', 'SecurityError'); })).not.toThrow();
  });

  it('does not touch storage at all without the parameter', () => {
    const get = vi.fn();
    persistRelayModeFromUrl('', get);
    expect(get).not.toHaveBeenCalled();
  });
});

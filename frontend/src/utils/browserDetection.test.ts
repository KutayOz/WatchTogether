import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissWarning, hasUserDismissedWarning } from './browserDetection';

/**
 * A real Storage, because the environment does not supply one — happy-dom's is
 * an empty object and Node's experimental global throws on every method unless
 * the process was started with --localstorage-file. Same fixture as
 * authStorage.test.ts, stubbed onto the bare global rather than onto window,
 * because that is the one this module reads.
 */
function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

/**
 * The dismissal round-trip.
 *
 * Small surface, but it is the kind that breaks silently: the writer and the
 * reader agree only by both naming the same localStorage key, and nothing else
 * in the app ever reads it. Rename the constant and every existing dismissal is
 * stranded — the warning comes back for everyone who already said "don't show
 * me this again", and no test, type or build step notices.
 */
describe('dismissed browser warnings', () => {
  let storage: Storage;

  beforeEach(() => {
    // Fresh per test, so nothing leaks between them.
    storage = makeStorage();
    vi.stubGlobal('localStorage', storage);
  });

  it('remembers a browser that was dismissed', () => {
    expect(hasUserDismissedWarning('Safari')).toBe(false);

    dismissWarning('Safari');

    expect(hasUserDismissedWarning('Safari')).toBe(true);
  });

  it('keeps dismissals separate per browser', () => {
    dismissWarning('Safari');

    // Same device, different browser: the warning is about this browser's
    // capabilities, so dismissing it in one says nothing about the other.
    expect(hasUserDismissedWarning('Firefox')).toBe(false);
  });

  it('accumulates rather than overwriting', () => {
    dismissWarning('Safari');
    dismissWarning('Firefox');

    expect(hasUserDismissedWarning('Safari')).toBe(true);
    expect(hasUserDismissedWarning('Firefox')).toBe(true);
  });

  it('is idempotent — dismissing twice stores one entry', () => {
    dismissWarning('Safari');
    dismissWarning('Safari');

    const stored = JSON.parse(
      storage.getItem('watchtogether_dismissed_warnings') ?? '[]',
    ) as string[];
    expect(stored).toEqual(['Safari']);
  });

  /**
   * Private browsing throws on localStorage access in some browsers, and a
   * cosmetic banner is never worth a blank page.
   */
  it('treats unreadable storage as "not dismissed" rather than throwing', () => {
    storage.setItem('watchtogether_dismissed_warnings', 'not json');

    expect(() => hasUserDismissedWarning('Safari')).not.toThrow();
    expect(hasUserDismissedWarning('Safari')).toBe(false);
  });
});

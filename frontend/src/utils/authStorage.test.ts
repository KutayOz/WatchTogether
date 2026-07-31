import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthData, getCachedUser, setAuthData, updateAuthItem } from './authStorage';

/**
 * A real Storage, because the environment does not supply one.
 *
 * happy-dom exposes window.localStorage as an empty object here, and modern
 * Node's own experimental localStorage global throws on every method unless the
 * process was started with --localstorage-file. Rather than depend on either,
 * the tests bring a Map-backed Storage of their own — which is also the right
 * scope: what is under test is this module's logic, not a browser's Storage.
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

const ADA = {
  username: 'ada',
  discriminator: '0042',
  tag: 'ada#0042',
  isRootUser: false,
  hasAcceptedTerms: true,
};

describe('authStorage', () => {
  beforeEach(() => {
    // Fresh pair per test, so nothing leaks between them.
    vi.stubGlobal('window', {
      ...globalThis.window,
      localStorage: makeStorage(),
      sessionStorage: makeStorage(),
    });
  });

  it('round-trips a cached user', () => {
    setAuthData(ADA);
    expect(getCachedUser()).toEqual(ADA);
  });

  it('reports no user when nothing is cached', () => {
    expect(getCachedUser()).toBeNull();
  });

  /**
   * A half-written cache renders a signed-in user with a blank handle, which
   * looks like data loss rather than the transient state it is. Dropping it
   * costs one /me round-trip and never shows a broken identity.
   */
  it('discards a cache missing the tag rather than rendering a blank handle', () => {
    setAuthData(ADA);
    window.localStorage.removeItem('tag');

    expect(getCachedUser()).toBeNull();
    // And the remnants are swept, so the next read is not half-valid either.
    expect(window.localStorage.getItem('username')).toBeNull();
  });

  it('discards a cache missing the discriminator', () => {
    setAuthData(ADA);
    window.localStorage.removeItem('discriminator');
    expect(getCachedUser()).toBeNull();
  });

  it('updates a single field in place', () => {
    setAuthData({ ...ADA, hasAcceptedTerms: false });
    updateAuthItem('hasAcceptedTerms', 'true');
    expect(getCachedUser()?.hasAcceptedTerms).toBe(true);
  });

  it('ignores an update when nobody is signed in', () => {
    updateAuthItem('hasAcceptedTerms', 'true');
    expect(getCachedUser()).toBeNull();
  });

  it('clears everything', () => {
    setAuthData(ADA);
    clearAuthData();
    expect(getCachedUser()).toBeNull();
  });

  /**
   * "Remember me" used to split the cache between localStorage and
   * window.sessionStorage. That preference is gone — the Worker issues one cookie
   * lifetime for every sign-in — but a browser that used the old build still
   * holds sessionStorage entries no current code path would ever read or
   * remove. Sweeping both stores is what stops them lingering.
   */
  it('sweeps entries left in sessionStorage by the old remember-me split', () => {
    window.sessionStorage.setItem('username', 'stale');
    window.sessionStorage.setItem('tag', 'stale#0001');
    window.localStorage.setItem('rememberMe', 'false');

    clearAuthData();

    expect(window.sessionStorage.getItem('username')).toBeNull();
    expect(window.sessionStorage.getItem('tag')).toBeNull();
    expect(window.localStorage.getItem('rememberMe')).toBeNull();
  });

  it('reads only localStorage, so a stale session entry cannot resurrect a user', () => {
    window.sessionStorage.setItem('username', 'ghost');
    window.sessionStorage.setItem('discriminator', '0001');
    window.sessionStorage.setItem('tag', 'ghost#0001');

    expect(getCachedUser()).toBeNull();
  });
});

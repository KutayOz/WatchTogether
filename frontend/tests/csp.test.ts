import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Content-Security-Policy in public/_headers is the one piece of this app
 * that no other test can reach: `vite dev` ignores the file, the unit suite
 * runs without it, and the only place it takes effect is production — where a
 * mistake shows up as a feature that silently does nothing. Background blur
 * has been broken in production this whole time for exactly that reason.
 *
 * So these tests read the shipped file and check it against what the code
 * actually loads.
 */

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

/** Parses Cloudflare's `_headers` format: a path line, then indented headers. */
function parseHeadersFile(text: string): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;

  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    if (!/^\s/.test(line)) {
      current = new Map();
      rules.set(line.trim(), current);
      continue;
    }

    const separator = line.indexOf(':');
    expect(separator, `header line without a colon: ${line}`).toBeGreaterThan(0);
    expect(current, `header line before any path: ${line}`).not.toBeNull();
    current!.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }

  return rules;
}

function parseCsp(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((tokens) => tokens[0])
      .map(([directive, ...sources]) => [directive, sources]),
  );
}

const rules = parseHeadersFile(read('../public/_headers'));
const global = rules.get('/*');
const csp = parseCsp(global?.get('Content-Security-Policy') ?? '');

describe('_headers', () => {
  it('applies a rule to every path', () => {
    expect(global).toBeDefined();
  });

  it.each([
    'Strict-Transport-Security',
    'X-Content-Type-Options',
    'X-Frame-Options',
    'Referrer-Policy',
    'Permissions-Policy',
    'Content-Security-Policy',
  ])('sets %s', (header) => {
    expect(global?.get(header)).toBeTruthy();
  });

  /**
   * Camera, microphone and screen capture are the whole app. A Permissions-
   * Policy that forgets one takes the feature away in every browser at once.
   */
  it.each(['camera', 'microphone', 'display-capture'])('permits %s for this origin', (feature) => {
    expect(global?.get('Permissions-Policy')).toContain(`${feature}=(self)`);
  });
});

describe('content security policy', () => {
  it('defaults to same-origin', () => {
    expect(csp.get('default-src')).toEqual(["'self'"]);
  });

  /**
   * These three do not fall back to default-src. A policy that locks down
   * default-src and stops there is still open to clickjacking, base-tag
   * hijacking and form redirection — which is the usual way a strict-looking
   * policy turns out not to be one.
   */
  it('spells out the directives that ignore default-src', () => {
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'self'"]);
    expect(csp.get('form-action')).toEqual(["'self'"]);
  });

  it('forbids plugins', () => {
    expect(csp.get('object-src')).toEqual(["'none'"]);
  });

  /**
   * The build emits no inline <script> (checked against dist/index.html, which
   * carries only external module tags), so there is nothing to trade away here.
   */
  it('allows no inline or eval scripting', () => {
    expect(csp.get('script-src')).not.toContain("'unsafe-inline'");
    expect(csp.get('script-src')).not.toContain("'unsafe-eval'");
  });

  /**
   * Styles are the exception, and it is a real one: several components render
   * a literal <style> block (App.tsx, Loading.tsx, PreflightLobby.tsx,
   * ConnectionQualityBadge.tsx). React inserts those as style elements, which
   * CSP treats as inline whatever created them, so dropping 'unsafe-inline'
   * would strip the app's keyframes rather than harden anything.
   */
  it('allows inline styles, which the components genuinely use', () => {
    expect(csp.get('style-src')).toContain("'unsafe-inline'");

    const withStyleBlocks = ['../src/App.tsx', '../src/components/common/Loading.tsx'];
    for (const file of withStyleBlocks) {
      expect(read(file)).toMatch(/<style>/);
    }
  });

  /**
   * WebAssembly compilation is gated by script-src: with a script-src set and
   * no 'wasm-unsafe-eval', WebAssembly.instantiate throws and the segmenter
   * never loads. Adding the CDN origins without this — which is what the
   * migration plan called for — would have left blur just as broken.
   */
  it("permits WebAssembly, which the segmenter's runtime needs", () => {
    expect(csp.get('script-src')).toContain("'wasm-unsafe-eval'");
  });

  /**
   * Drift check rather than a restatement: the origins come out of the hook
   * itself, so moving the model or the WASM bundle fails here instead of in
   * production.
   */
  it('covers every origin the background-blur hook fetches from', () => {
    const source = read('../src/hooks/useBackgroundBlur.ts')
      .split('\n')
      // Comments in this file cite URLs too; only real code counts.
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');

    const origins = new Set([...source.matchAll(/https:\/\/[a-z0-9.-]+/gi)].map((m) => m[0]));

    expect(origins.size).toBeGreaterThan(0);
    for (const origin of origins) {
      expect(csp.get('connect-src'), `connect-src is missing ${origin}`).toContain(origin);
    }

    // The WASM loader arrives as a <script> tag the segmenter appends to the
    // document, so its origin has to be a script source as well as a fetch one.
    expect(csp.get('script-src')).toContain('https://cdn.jsdelivr.net');
  });

  /**
   * Safari did not match ws/wss against 'self' until relatively recently, and
   * a signalling socket the browser refuses to open is a dead app rather than a
   * degraded one. Naming the origin outright costs nothing.
   */
  it('names the signalling socket origin outright', () => {
    expect(csp.get('connect-src')?.some((source) => source.startsWith('wss://'))).toBe(true);
  });

  it('allows the YouTube player the watch-together feature embeds', () => {
    expect(csp.get('script-src')).toContain('https://www.youtube.com');
    expect(csp.get('frame-src')).toContain('https://www.youtube.com');
  });

  /**
   * The fonts are loaded by <link> tags in index.html — a stylesheet from one
   * origin that then pulls font files from another.
   */
  it('allows the webfonts index.html links to', () => {
    expect(read('../index.html')).toContain('https://fonts.googleapis.com/css2');
    expect(csp.get('style-src')).toContain('https://fonts.googleapis.com');
    expect(csp.get('font-src')).toContain('https://fonts.gstatic.com');
  });
});

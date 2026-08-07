import { describe, expect, it } from 'vitest';
import { describeWebAuthnError } from './useAuth';

/**
 * A WebAuthn rejection is the whole of the error UI on the passkey path — the
 * browser gives no second chance and no "forgot" flow to redirect into. So a
 * blank message here is not cosmetic; it is a user with no way to tell "you
 * cancelled" from "this browser can't do this".
 *
 * There is a password form on the same screen now, but it does not soften this:
 * somebody reaching for a passkey has one, and being told nothing about why it
 * failed is not answered by pointing at a password they may not have set.
 */
describe('describeWebAuthnError', () => {
  const FALLBACK = 'Sign-in failed';

  /**
   * The important one. The spec deliberately collapses several outcomes into
   * NotAllowedError so a site cannot distinguish "no credential exists" from
   * "the user refused" — which is good for privacy and terrible for error copy,
   * because the DOMException's own `message` is usually empty.
   */
  it('explains NotAllowedError, whose own message is empty', () => {
    const err = new Error('');
    err.name = 'NotAllowedError';

    expect(err.message).toBe('');
    expect(describeWebAuthnError(err, FALLBACK)).toMatch(/dismissed or timed out/i);
  });

  it.each([
    ['InvalidStateError', /already has a passkey/i],
    ['NotSupportedError', /cannot create passkeys/i],
    ['SecurityError', /unavailable on this address/i],
    ['AbortError', /cancelled/i],
  ])('explains %s', (name, expected) => {
    const err = new Error('');
    err.name = name;
    expect(describeWebAuthnError(err, FALLBACK)).toMatch(expected);
  });

  /**
   * Server-side failures are plain Errors carrying the API's message, which is
   * already written for a person — "That username is unavailable", "That invite
   * link has already been used". Overwriting those with a generic fallback
   * would lose the only actionable part.
   */
  it('passes a server message through untouched', () => {
    const err = new Error('That username is unavailable. Please pick another.');
    expect(describeWebAuthnError(err, FALLBACK)).toBe(
      'That username is unavailable. Please pick another.',
    );
  });

  it('falls back when an unnamed error carries no message', () => {
    expect(describeWebAuthnError(new Error(''), FALLBACK)).toBe(FALLBACK);
  });

  it.each([
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['an object', { message: 'nope' }],
  ])('falls back for %s, which is not an Error at all', (_label, thrown) => {
    expect(describeWebAuthnError(thrown, FALLBACK)).toBe(FALLBACK);
  });

  it('never returns an empty string, whatever it is handed', () => {
    const cases: unknown[] = [
      new Error(''),
      Object.assign(new Error(''), { name: 'NotAllowedError' }),
      Object.assign(new Error(''), { name: 'WeirdUnknownError' }),
      'string',
      null,
    ];
    for (const c of cases) {
      expect(describeWebAuthnError(c, FALLBACK).length).toBeGreaterThan(0);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { CLIENT_KDF_VERSION } from '@shared/password';
import {
  buildPasswordCredential,
  describePassword,
  isPasswordValid,
  isTagValid,
  saltUsernameFromTag,
} from './password';

/**
 * The browser's half of password handling.
 *
 * The rules themselves are the Worker's and are tested there
 * (worker/src/lib/password.test.ts); what is worth pinning on this side is the
 * wiring that is easy to get subtly wrong — that a handle is taken apart into
 * the same salt the server will expect, and that what leaves here is a derived
 * key rather than anything a person typed.
 */

const GOOD = 'orbital-teapot-42';

describe('saltUsernameFromTag', () => {
  it('takes the username half and lowercases it', () => {
    expect(saltUsernameFromTag('Alice#0042')).toBe('alice');
    expect(saltUsernameFromTag('  Alice#0042  ')).toBe('alice');
  });

  it('rejects anything that is not a full handle', () => {
    // Getting this wrong does not fail loudly: a bad salt derives a perfectly
    // valid key that simply does not match, and the server can only answer
    // "those do not match". Refusing up front is what keeps that debuggable.
    expect(saltUsernameFromTag('alice')).toBeNull();
    expect(saltUsernameFromTag('alice#42')).toBeNull();
    expect(saltUsernameFromTag('alice#abcd')).toBeNull();
    expect(saltUsernameFromTag('#0042')).toBeNull();
    expect(saltUsernameFromTag('')).toBeNull();
  });

  it('rejects a handle whose username half the server would refuse', () => {
    expect(saltUsernameFromTag('ab#0042')).toBeNull();
    expect(saltUsernameFromTag('has spaces#0042')).toBeNull();
  });
});

describe('isTagValid', () => {
  it('gates the sign-in button on a complete handle', () => {
    expect(isTagValid('alice#0042')).toBe(true);
    expect(isTagValid('alice')).toBe(false);
  });
});

describe('describePassword', () => {
  it('says nothing about an empty field', () => {
    // An untouched input is not yet wrong.
    expect(describePassword('')).toBeNull();
  });

  it('says nothing about an acceptable password', () => {
    expect(describePassword(GOOD)).toBeNull();
  });

  it('surfaces the shared rulebook’s own wording', () => {
    expect(describePassword('short')).toBe('Password must be at least 12 characters.');
    expect(describePassword('alice-alice-alice', 'alice')).toBe(
      'Password must not contain your username.',
    );
  });

  it('agrees with isPasswordValid', () => {
    for (const [password, username] of [
      [GOOD, undefined],
      ['short', undefined],
      ['alice-alice-alice', 'alice'],
      ['password1234', undefined],
    ] as const) {
      expect(isPasswordValid(password, username)).toBe(describePassword(password, username) === null);
    }
  });
});

describe('buildPasswordCredential', () => {
  it('produces a derived key and the recipe that made it', async () => {
    const credential = await buildPasswordCredential(GOOD, 'alice');

    expect(credential.clientKdfVersion).toBe(CLIENT_KDF_VERSION);
    expect(credential.clientKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The plaintext must not be recoverable from, or present in, what ships.
    expect(credential.clientKey).not.toContain(GOOD);
    expect(JSON.stringify(credential)).not.toContain(GOOD);
  });

  it('salts by username, so the same password differs per account', async () => {
    const alice = await buildPasswordCredential(GOOD, 'alice');
    const bob = await buildPasswordCredential(GOOD, 'bob');

    expect(alice.clientKey).not.toBe(bob.clientKey);
  });

  it('is deterministic, or nobody could ever sign in twice', async () => {
    const first = await buildPasswordCredential(GOOD, 'alice');
    const second = await buildPasswordCredential(GOOD, 'alice');

    expect(first.clientKey).toBe(second.clientKey);
  });
});

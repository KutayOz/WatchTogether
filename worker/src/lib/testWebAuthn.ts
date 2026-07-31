/**
 * A minimal software authenticator, for tests.
 *
 * Produces genuine WebAuthn ceremony responses that @simplewebauthn/server
 * verifies for real — no mocking of the verification path, which is precisely
 * the part worth exercising and the part whose CPU cost has to fit inside the
 * Workers free plan's 10ms budget.
 *
 * Registration is tractable because `attestationType: "none"` means the
 * attestation statement is empty: there is no attestation signature to forge,
 * only a correctly-shaped CBOR structure. Authentication does require a real
 * ES256 signature, which WebCrypto provides.
 */

import { fromBase64Url, toBase64Url } from "./crypto";

// ---------------------------------------------------------------------------
// Just enough CBOR to build an attestation object
// ---------------------------------------------------------------------------

function cborHead(majorType: number, length: number): Uint8Array {
  if (length < 24) return new Uint8Array([(majorType << 5) | length]);
  if (length < 0x100) return new Uint8Array([(majorType << 5) | 24, length]);
  if (length < 0x10000) {
    return new Uint8Array([(majorType << 5) | 25, length >> 8, length & 0xff]);
  }
  return new Uint8Array([
    (majorType << 5) | 26,
    (length >> 24) & 0xff,
    (length >> 16) & 0xff,
    (length >> 8) & 0xff,
    length & 0xff,
  ]);
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const cborUint = (value: number) => cborHead(0, value);
/** CBOR encodes -1 as 0, -2 as 1, and so on. */
const cborNegative = (value: number) => cborHead(1, -value - 1);
const cborBytes = (bytes: Uint8Array) => concat(cborHead(2, bytes.length), bytes);
const cborText = (text: string) => {
  const encoded = new TextEncoder().encode(text);
  return concat(cborHead(3, encoded.length), encoded);
};
const cborMap = (entries: Uint8Array[][]) =>
  concat(cborHead(5, entries.length), ...entries.flat());

// ---------------------------------------------------------------------------
// Authenticator
// ---------------------------------------------------------------------------

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;

export interface TestAuthenticator {
  credentialId: string;
  register(challenge: string, origin: string): Promise<Record<string, unknown>>;
  authenticate(
    challenge: string,
    origin: string,
    userHandle: string,
    counter?: number,
  ): Promise<Record<string, unknown>>;
}

async function coseKeyFor(publicKey: CryptoKey): Promise<Uint8Array> {
  // exportKey is typed as returning ArrayBuffer | JsonWebKey; the "jwk" format
  // always yields the latter.
  const jwk = (await crypto.subtle.exportKey("jwk", publicKey)) as JsonWebKey;

  // COSE_Key for ES256: kty=EC2(2), alg=ES256(-7), crv=P-256(1), then x and y.
  return cborMap([
    [cborUint(1), cborUint(2)],
    [cborUint(3), cborNegative(-7)],
    [cborNegative(-1), cborUint(1)],
    [cborNegative(-2), cborBytes(fromBase64Url(jwk.x!))],
    [cborNegative(-3), cborBytes(fromBase64Url(jwk.y!))],
  ]);
}

function clientData(type: string, challenge: string, origin: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ type, challenge, origin, crossOrigin: false }),
  );
}

async function authenticatorData(
  rpId: string,
  flags: number,
  counter: number,
  attested?: Uint8Array,
): Promise<Uint8Array> {
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)),
  );
  const counterBytes = new Uint8Array([
    (counter >> 24) & 0xff,
    (counter >> 16) & 0xff,
    (counter >> 8) & 0xff,
    counter & 0xff,
  ]);

  return attested
    ? concat(rpIdHash, new Uint8Array([flags]), counterBytes, attested)
    : concat(rpIdHash, new Uint8Array([flags]), counterBytes);
}

export async function createTestAuthenticator(rpId: string): Promise<TestAuthenticator> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const credentialIdBytes = crypto.getRandomValues(new Uint8Array(32));
  const credentialId = toBase64Url(credentialIdBytes);

  return {
    credentialId,

    async register(challenge, origin) {
      const attestedCredentialData = concat(
        new Uint8Array(16), // AAGUID, all zeroes for a software authenticator
        new Uint8Array([credentialIdBytes.length >> 8, credentialIdBytes.length & 0xff]),
        credentialIdBytes,
        await coseKeyFor(keyPair.publicKey),
      );

      const authData = await authenticatorData(
        rpId,
        FLAG_USER_PRESENT | FLAG_USER_VERIFIED | FLAG_ATTESTED_CREDENTIAL_DATA,
        0,
        attestedCredentialData,
      );

      // fmt "none" carries an empty attStmt, so nothing here needs signing.
      const attestationObject = cborMap([
        [cborText("fmt"), cborText("none")],
        [cborText("attStmt"), cborMap([])],
        [cborText("authData"), cborBytes(authData)],
      ]);

      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: toBase64Url(clientData("webauthn.create", challenge, origin)),
          attestationObject: toBase64Url(attestationObject),
          transports: ["internal"],
        },
      };
    },

    async authenticate(challenge, origin, userHandle, counter = 1) {
      const authData = await authenticatorData(
        rpId,
        FLAG_USER_PRESENT | FLAG_USER_VERIFIED,
        counter,
      );
      const clientDataJSON = clientData("webauthn.get", challenge, origin);
      const clientDataHash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", clientDataJSON),
      );

      // The assertion signature covers authData || SHA-256(clientDataJSON).
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          keyPair.privateKey,
          concat(authData, clientDataHash),
        ),
      );

      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: toBase64Url(clientDataJSON),
          authenticatorData: toBase64Url(authData),
          // WebCrypto emits raw r||s; WebAuthn expects DER.
          signature: toBase64Url(rawSignatureToDer(signature)),
          userHandle,
        },
      };
    },
  };
}

/** Wrap a raw 64-byte r||s signature in the DER SEQUENCE WebAuthn expects. */
function rawSignatureToDer(raw: Uint8Array): Uint8Array {
  const toDerInteger = (value: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start++;
    const trimmed = value.slice(start);
    // A leading high bit would read as negative, so pad with a zero byte.
    const body = trimmed[0]! & 0x80 ? concat(new Uint8Array([0]), trimmed) : trimmed;
    return concat(new Uint8Array([0x02, body.length]), body);
  };

  const r = toDerInteger(raw.slice(0, 32));
  const s = toDerInteger(raw.slice(32, 64));
  return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
}

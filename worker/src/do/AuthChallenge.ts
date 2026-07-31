// Env is declared globally by the generated worker-configuration.d.ts.

/** WebAuthn ceremonies are interactive; two minutes is generous. */
const CHALLENGE_TTL_MS = 2 * 60 * 1000;

export type ChallengeKind = "reg-new" | "reg-add" | "auth";

export interface StoredChallenge {
  kind: ChallengeKind;
  challenge: string;
  expiresAt: number;

  /** reg-new: the identity to create once the ceremony succeeds. */
  userId?: string;
  userHandle?: string;
  username?: string;
  usernameLower?: string;
  inviteTokenLookup?: string;

  /** reg-add: the already-authenticated user gaining another credential. */
  existingUserId?: string;
}

/**
 * One instance per in-flight WebAuthn ceremony, addressed by
 * `env.CHALLENGE.idFromName(challenge)`.
 *
 * Replaces the IMemoryCache in PasskeyService.cs:37, which pinned the .NET app
 * to a single instance.
 *
 * Not KV, for two reasons. A challenge must be readable a few seconds after
 * being written, possibly from a different colo, and KV's read-after-write is
 * not guaranteed across colos. And KV cannot consume-and-delete atomically, so
 * an assertion could be replayed inside the two-minute window.
 *
 * Keyed by challenge rather than by user so ceremonies shard naturally instead
 * of funnelling every login through one hot object, and so registration and
 * authentication share one mechanism — both already recover the challenge from
 * clientDataJSON.
 */
export class AuthChallenge {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/put") {
      const challenge = await request.json<StoredChallenge>();
      await this.state.storage.put("challenge", challenge);
      // Backstop only: the happy path deletes on consume. This reclaims
      // storage for ceremonies the user abandoned.
      await this.state.storage.setAlarm(challenge.expiresAt);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/consume") {
      const stored = await this.state.storage.get<StoredChallenge>("challenge");

      // Read and delete inside one invocation. The runtime will not interleave
      // a second /consume between them, so single-use is structural rather
      // than something to enforce with a compare-and-swap.
      await this.state.storage.deleteAll();

      if (!stored) return Response.json({ ok: false, error: "not_found" });
      if (stored.expiresAt <= Date.now()) return Response.json({ ok: false, error: "expired" });

      return Response.json({ ok: true, challenge: stored });
    }

    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

export { CHALLENGE_TTL_MS };

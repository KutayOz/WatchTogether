-- WatchTogether initial schema.
--
-- Ported from the MongoDB collections in backend/Data/Entities — deleted now,
-- readable at `git show archive/dotnet:backend/Data/Entities/User.cs` — with
-- three deliberate departures:
--
--   1. Identity is `username#discriminator`, not email. Email is gone entirely
--      along with all verification machinery.
--   2. Passkey credentials are a real table rather than an array embedded on
--      the user document. They were unindexed in Mongo, so every credential
--      lookup was a collection scan.
--   3. No BCrypt column on invitation_links. Invite tokens carry 256 bits of
--      entropy, so there is nothing to brute-force and BCrypt's cost factor
--      bought nothing — it just cost ~400ms of CPU we do not have on the
--      Workers free plan. SHA-256 lookup only.
--
-- Conventions: binary is base64url TEXT (string compares, greppable rows),
-- timestamps are INTEGER unix-millis, booleans are INTEGER 0/1.

CREATE TABLE users (
  id                 TEXT    PRIMARY KEY,          -- crypto.randomUUID()
  username           TEXT    NOT NULL,             -- as typed, case preserved
  username_lower     TEXT    NOT NULL,             -- .toLowerCase(), never toLocaleLowerCase
  discriminator      TEXT    NOT NULL,             -- '0001'..'9999'; '0000' reserved for root
  user_handle        TEXT    NOT NULL,             -- base64url(32 bytes) = WebAuthn user.id
  is_root            INTEGER NOT NULL DEFAULT 0,
  active_link_count  INTEGER NOT NULL DEFAULT 0,   -- atomic invite-slot counter
  invited_by_user_id TEXT             REFERENCES users(id) ON DELETE SET NULL,
  accepted_terms_at  INTEGER,
  terms_version      TEXT,
  created_at         INTEGER NOT NULL,
  is_deleted         INTEGER NOT NULL DEFAULT 0,
  deleted_at         INTEGER,
  deleted_by_user_id TEXT
);

-- The identity constraint. Allocation draws a random discriminator and relies
-- on this index to reject collisions (see lib/identity.ts).
CREATE UNIQUE INDEX uniq_users_tag    ON users(username_lower, discriminator);
-- user_handle is generated exactly once, at registration begin, and lives here
-- rather than being derived per-ceremony. The .NET code called EnsureUserHandle
-- twice without persisting between (PasskeyService.cs:55 and :138), so a user's
-- first credential got one handle sent to the authenticator and a different one
-- written to the database.
CREATE UNIQUE INDEX uniq_users_handle ON users(user_handle);
CREATE INDEX        idx_users_invited ON users(invited_by_user_id);

CREATE TABLE passkey_credentials (
  credential_id   TEXT    PRIMARY KEY,             -- base64url; PK gives global uniqueness free
  user_id         TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key      TEXT    NOT NULL,                -- base64url COSE key
  counter         INTEGER NOT NULL DEFAULT 0,      -- signature counter, clone detection
  transports      TEXT,                            -- JSON array; absent in the Mongo schema
  aaguid          TEXT,
  backup_eligible INTEGER NOT NULL DEFAULT 0,
  backed_up       INTEGER NOT NULL DEFAULT 0,
  label           TEXT    NOT NULL,
  registered_at   INTEGER NOT NULL,
  last_used_at    INTEGER
);
CREATE INDEX idx_cred_user ON passkey_credentials(user_id);

CREATE TABLE invitation_links (
  id              TEXT    PRIMARY KEY,
  token_lookup    TEXT    NOT NULL UNIQUE,         -- sha256(token) lowercase hex
  inviter_user_id TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,                -- created_at + 48h
  used_at         INTEGER,
  used_by_user_id TEXT             REFERENCES users(id) ON DELETE SET NULL,
  ticket_returned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_links_inviter ON invitation_links(inviter_user_id);
-- Partial index for the nightly expired-ticket sweep, which only ever looks at
-- links that are still outstanding.
CREATE INDEX idx_links_open    ON invitation_links(expires_at)
  WHERE used_at IS NULL AND ticket_returned = 0;

-- JWT deny-list. Mongo expired these with a TTL index; D1 has no equivalent, so
-- the nightly cron sweeps rows past expires_at.
CREATE TABLE revoked_tokens (
  jti        TEXT    PRIMARY KEY,
  user_id    TEXT,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER NOT NULL
);
CREATE INDEX idx_revoked_expiry ON revoked_tokens(expires_at);

CREATE TABLE admin_audit_log (
  id            TEXT    PRIMARY KEY,
  actor_user_id TEXT    NOT NULL,
  actor_tag     TEXT,                              -- 'name#1234' snapshot at write time
  action        TEXT    NOT NULL,
  target_type   TEXT    NOT NULL,
  target_id     TEXT    NOT NULL,
  details       TEXT,
  ip_address    TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON admin_audit_log(created_at DESC);
CREATE INDEX idx_audit_actor   ON admin_audit_log(actor_user_id);

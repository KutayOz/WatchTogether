-- Password credentials, and the root-issued tickets that restore them.
--
-- 0001 shipped without either, and its header says why: BCrypt at work factor
-- 12 costs ~400ms of CPU that the Workers free plan does not have. That
-- constraint is real. The conclusion drawn from it — that passwords are
-- impossible here — was too strong, and this migration is the correction.
--
-- What is actually true on this runtime: bcrypt, scrypt and argon2 do not
-- exist, so PBKDF2 via crypto.subtle is the only option, and OWASP asks for
-- 600,000 iterations of it. Measured in workerd, that costs ~37ms of compute
-- against a 10ms budget. Server-side stretching cannot reach current guidance
-- here — but a *slower server hash* was never what would have fixed that.
--
-- The work is therefore split. The browser runs PBKDF2-SHA256 at 600,000 over
-- a salt derived from the username; the Worker runs 20,000 more over a random
-- per-row salt and stores only that. An attacker holding this table pays both
-- halves, ~620,000 iterations per guess. The Worker pays ~1.2ms of its 10.
-- See worker/src/lib/password.ts (shared with the browser) and
-- worker/src/lib/passwordHash.ts (server only).
--
-- Two tables rather than columns on `users`, for the same reason passkeys got
-- their own in 0001 (departure 2): getUserById does SELECT * into UserRow on
-- every authenticated request, so a hash living there would ride along in
-- c.get("user") and in the admin listing, one careless c.json(row) from a leak.
--
-- Conventions unchanged from 0001: binary is base64url TEXT, timestamps are
-- INTEGER unix-millis, booleans are INTEGER 0/1.

CREATE TABLE password_credentials (
  user_id         TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash   TEXT    NOT NULL,             -- $wtpw$v=1$…: the KDF params live inside the value
  updated_at      INTEGER NOT NULL,             -- first set, and every change after
  last_used_at    INTEGER,
  failed_attempts INTEGER NOT NULL DEFAULT 0,   -- consecutive; zeroed on success
  locked_until    INTEGER                       -- unix millis, NULL = not locked
);
-- No index. The primary key covers the only access path there is:
-- tag -> uniq_users_tag -> users.id -> here. And absence of a row *is* "no
-- password set", which is why nothing above is nullable except the two
-- genuinely optional timestamps.

-- Password resets, issued by root.
--
-- There is no email address anywhere in this schema, so a forgotten password
-- has no self-service path. Root mints a single-use ticket and hands the link
-- over out of band; redeeming it sets a new password and signs the user in.
--
-- Deliberately not stored in invitation_links, which looked like free reuse:
-- returnExpiredTickets() releases an invite slot for every expired row it
-- sweeps, so reset tickets living there would quietly mint invite quota every
-- night. The pattern is reused (sha256 lookup, 48h TTL, single-use burn in the
-- UPDATE's WHERE clause); the table is not.
CREATE TABLE password_reset_tokens (
  token_lookup TEXT    PRIMARY KEY,             -- sha256(token) lowercase hex; the raw token is never stored
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_by    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,                -- created_at + 48h
  used_at      INTEGER
);
CREATE INDEX idx_pwreset_user ON password_reset_tokens(user_id);
-- Partial index for the nightly sweep, which only ever looks at unspent tickets.
CREATE INDEX idx_pwreset_open ON password_reset_tokens(expires_at)
  WHERE used_at IS NULL;

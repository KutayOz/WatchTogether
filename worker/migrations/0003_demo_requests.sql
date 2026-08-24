-- Demo requests: a queue for people who want in and hold no invite.
--
-- The screen this feeds existed once and was deleted in 84d9624 along with
-- everything else built on sending email — correctly, because approving a
-- request meant emailing an invite and there was no longer anything to email
-- with. What is restored here is the queue, not the mail: root reads it, and
-- approval mints an invite link that root passes on by hand. That is the same
-- shape password recovery already has (0002, password_reset_tokens), and the
-- honest one for an app whose whole identity model has no address in it.
--
-- Which is also why `email` lives here and nowhere near `users`. It is a
-- reply-to on a piece of correspondence from somebody who has no account, kept
-- only until the request is dealt with and swept 30 days later
-- (sweepReviewedDemoRequests, run by the nightly cron). Registering through the
-- resulting invite does not copy it anywhere — the account that comes out the
-- other end has a username and a tag, as every account does.
--
-- Conventions unchanged from 0001: timestamps are INTEGER unix-millis, ids are
-- TEXT UUIDs, and status is TEXT rather than an INTEGER enum so the admin_audit
-- rows and the D1 console read the same as the code.
CREATE TABLE demo_requests (
  id               TEXT    PRIMARY KEY,
  email            TEXT    NOT NULL,            -- as typed, because it is what root will write to
  email_lookup     TEXT    NOT NULL,            -- trimmed + lowercased; the only form ever compared
  display_name     TEXT    NOT NULL,
  message          TEXT,                        -- optional, capped at 500 chars by the route
  status           TEXT    NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  submitted_at     INTEGER NOT NULL,
  reviewed_at      INTEGER,
  reviewed_by      TEXT             REFERENCES users(id) ON DELETE SET NULL,
  rejection_reason TEXT,
  ip_address       TEXT                         -- CF-Connecting-IP, for spotting a flood
);

-- The admin list is "newest first, bounded" and nothing else.
CREATE INDEX idx_demo_submitted ON demo_requests(submitted_at DESC);

-- One open request per address. This is the actual anti-flood measure: the rate
-- limiter bounds requests per IP per minute, which does nothing about the same
-- person submitting once a day for a week. A partial index rather than a plain
-- UNIQUE, so a rejected applicant can apply again later and an approved one can
-- come back if their link went stale.
--
-- The insert path treats the resulting constraint failure as success (see
-- createDemoRequest): a second submission is not an error worth showing, and
-- answering it differently would turn this into an "is this address already
-- waiting?" oracle.
CREATE UNIQUE INDEX uniq_demo_open ON demo_requests(email_lookup) WHERE status = 'pending';

-- Partial, for the nightly sweep, which only ever looks at rows already dealt
-- with. Pending rows are never swept — nobody's request expires unread.
CREATE INDEX idx_demo_reviewed ON demo_requests(reviewed_at) WHERE reviewed_at IS NOT NULL;

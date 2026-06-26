using Microsoft.Extensions.Configuration;
using MongoDB.Bson;
using MongoDB.Driver;
using WatchTogether.Data.Entities;

namespace WatchTogether.Data.Context;

public class MongoDbContext
{
    private readonly IMongoDatabase _database;

    public MongoDbContext(IConfiguration configuration)
    {
        var connectionString = configuration["MongoDB:ConnectionString"];
        if (string.IsNullOrWhiteSpace(connectionString))
            throw new InvalidOperationException("MongoDB:ConnectionString must be set (set MongoDB__ConnectionString env var)");
        var databaseName = configuration["MongoDB:DatabaseName"];
        if (string.IsNullOrWhiteSpace(databaseName))
            throw new InvalidOperationException("MongoDB:DatabaseName must be set");

        // Cap connection pool aggressively — this app has tiny DB traffic (auth + invites),
        // and on a 256 MB Fly machine each idle connection's state buffers add up fast.
        // Default is 100; a 2-person-per-session app needs ~5.
        var settings = MongoClientSettings.FromConnectionString(connectionString);
        settings.MaxConnectionPoolSize = 10;
        settings.MinConnectionPoolSize = 0;
        settings.MaxConnectionIdleTime = TimeSpan.FromMinutes(2);

        var client = new MongoClient(settings);
        _database = client.GetDatabase(databaseName);
    }

    public IMongoCollection<User> Users => _database.GetCollection<User>("users");
    public IMongoCollection<Invitation> Invitations => _database.GetCollection<Invitation>("invitations");
    public IMongoCollection<InvitationLink> InvitationLinks => _database.GetCollection<InvitationLink>("invitationLinks");
    public IMongoCollection<RevokedToken> RevokedTokens => _database.GetCollection<RevokedToken>("revokedTokens");
    public IMongoCollection<AdminAuditLog> AdminAuditLog => _database.GetCollection<AdminAuditLog>("adminAuditLog");
    public IMongoCollection<DemoRequest> DemoRequests => _database.GetCollection<DemoRequest>("demoRequests");

    /// <summary>
    /// Create all required indexes. Idempotent — re-running is a no-op when the index
    /// already exists with matching keys+options. Called once at app startup.
    ///
    /// Why this matters:
    ///   - Without a unique index on users.email, two concurrent registrations with the
    ///     same email both pass the application-level ExistsAsync check and create
    ///     duplicate accounts (TOCTOU race).
    ///   - Without indexed token lookups, the invitation/verification flow does an O(n)
    ///     BCrypt-verify-against-every-row scan on anonymous endpoints — easy DoS.
    /// </summary>
    public async Task EnsureIndexesAsync()
    {
        // Sparse unique indexes only ignore documents where the field is absent.
        // They still index explicit null values. Older entity mappings wrote
        // nullable fields as `field: null`, which made password-only users collide
        // on uniq_googleId / uniq_emailVerificationTokenLookup and surfaced as a
        // misleading "email already exists" registration error.
        await UnsetNullSparseIndexFieldsAsync();

        // users.email — UNIQUE. Emails are normalized to lowercase on insert in the
        // services, so a plain ascending index is sufficient. (We considered a collation
        // index for case-insensitivity, but queries would need to specify the collation
        // every time to actually use it; the lowercase-on-write approach is simpler and
        // faster.)
        await Users.Indexes.CreateOneAsync(new CreateIndexModel<User>(
            Builders<User>.IndexKeys.Ascending(u => u.Email),
            new CreateIndexOptions { Unique = true, Name = "uniq_email" }));

        // users.invitedByUserId — non-unique, used by admin tree builder and
        // GetInvitedByUserAsync.
        await Users.Indexes.CreateOneAsync(new CreateIndexModel<User>(
            Builders<User>.IndexKeys.Ascending(u => u.InvitedByUserId),
            new CreateIndexOptions { Name = "idx_invitedByUserId" }));

        // users.emailVerificationTokenLookup — UNIQUE, sparse. Same pattern as
        // InvitationLink.tokenLookup: SHA-256 of the verification token for O(1) lookup
        // instead of BCrypt-scanning every unverified user.
        await Users.Indexes.CreateOneAsync(new CreateIndexModel<User>(
            Builders<User>.IndexKeys.Ascending(u => u.EmailVerificationTokenLookup),
            new CreateIndexOptions { Unique = true, Sparse = true, Name = "uniq_emailVerificationTokenLookup" }));

        // users.googleId — UNIQUE, sparse. Used by AuthService.GoogleSignInAsync
        // for O(1) lookup of a returning Google user. Sparse because most
        // password-only users have no Google ID at all.
        await Users.Indexes.CreateOneAsync(new CreateIndexModel<User>(
            Builders<User>.IndexKeys.Ascending(u => u.GoogleId),
            new CreateIndexOptions { Unique = true, Sparse = true, Name = "uniq_googleId" }));

        // invitations.invitationToken — UNIQUE. Field now stores the BCrypt hash
        // of the token (post final-tidy). Sparse because not every Invitation has
        // a token (defensive).
        await Invitations.Indexes.CreateOneAsync(new CreateIndexModel<Invitation>(
            Builders<Invitation>.IndexKeys.Ascending(i => i.InvitationToken),
            new CreateIndexOptions { Unique = true, Sparse = true, Name = "uniq_invitationToken" }));

        // invitations.tokenLookup — UNIQUE, sparse. SHA-256(token) hex for fast
        // O(1) lookup. Same pattern as InvitationLink.tokenLookup.
        await Invitations.Indexes.CreateOneAsync(new CreateIndexModel<Invitation>(
            Builders<Invitation>.IndexKeys.Ascending(i => i.TokenLookup),
            new CreateIndexOptions { Unique = true, Sparse = true, Name = "uniq_invitation_tokenLookup" }));

        // invitations.inviterUserId — non-unique, used by GetByInviterUserIdAsync.
        await Invitations.Indexes.CreateOneAsync(new CreateIndexModel<Invitation>(
            Builders<Invitation>.IndexKeys.Ascending(i => i.InviterUserId),
            new CreateIndexOptions { Name = "idx_invitation_inviterUserId" }));

        // invitationLinks.inviterUserId — non-unique, used by slot counting and
        // GetActiveByInviterUserIdAsync.
        await InvitationLinks.Indexes.CreateOneAsync(new CreateIndexModel<InvitationLink>(
            Builders<InvitationLink>.IndexKeys.Ascending(l => l.InviterUserId),
            new CreateIndexOptions { Name = "idx_link_inviterUserId" }));

        // invitationLinks.tokenLookup — UNIQUE, sparse. Added by the C1 fix (fast token
        // lookup). Sparse so legacy rows without the field don't conflict.
        await InvitationLinks.Indexes.CreateOneAsync(new CreateIndexModel<InvitationLink>(
            Builders<InvitationLink>.IndexKeys.Ascending(l => l.TokenLookup),
            new CreateIndexOptions { Unique = true, Sparse = true, Name = "uniq_tokenLookup" }));

        // TTL indexes — Mongo background thread (~60s polling) auto-deletes
        // documents whose datetime field is older than expireAfterSeconds. Without
        // these, expired invitation rows accumulate forever; PII (invitee emails)
        // outlives its purpose.
        //
        // For invitationLinks we set TTL on ExpiresAt with 30-day grace so that
        // an audit query can still see "expired 3 weeks ago" rows; after 30 days
        // they're auto-purged. Same for invitations.
        var ttlDays = TimeSpan.FromDays(30);
        await InvitationLinks.Indexes.CreateOneAsync(new CreateIndexModel<InvitationLink>(
            Builders<InvitationLink>.IndexKeys.Ascending(l => l.ExpiresAt),
            new CreateIndexOptions { ExpireAfter = ttlDays, Name = "ttl_expiresAt" }));
        await Invitations.Indexes.CreateOneAsync(new CreateIndexModel<Invitation>(
            Builders<Invitation>.IndexKeys.Ascending(i => i.ExpiresAt),
            new CreateIndexOptions { ExpireAfter = ttlDays, Name = "ttl_expiresAt" }));

        // revokedTokens.jti — UNIQUE so a concurrent double-revoke from two tabs
        // hits a duplicate-key error and the repo swallows it (idempotent).
        await RevokedTokens.Indexes.CreateOneAsync(new CreateIndexModel<RevokedToken>(
            Builders<RevokedToken>.IndexKeys.Ascending(t => t.Jti),
            new CreateIndexOptions { Unique = true, Name = "uniq_jti" }));

        // revokedTokens.expiresAt — TTL with zero grace. The original JWT was
        // already invalid once it passed its exp; keeping the deny-list entry
        // any longer is pure overhead. Mongo's TTL reaper auto-purges within ~60s.
        await RevokedTokens.Indexes.CreateOneAsync(new CreateIndexModel<RevokedToken>(
            Builders<RevokedToken>.IndexKeys.Ascending(t => t.ExpiresAt),
            new CreateIndexOptions { ExpireAfter = TimeSpan.Zero, Name = "ttl_jti_expiry" }));

        // adminAuditLog.timestamp — descending so "recent activity" queries
        // (the typical view shape) are fast without a separate sort stage.
        await AdminAuditLog.Indexes.CreateOneAsync(new CreateIndexModel<AdminAuditLog>(
            Builders<AdminAuditLog>.IndexKeys.Descending(e => e.Timestamp),
            new CreateIndexOptions { Name = "idx_audit_timestamp" }));

        // adminAuditLog.actorUserId — for "what did this admin do?" queries
        // during incident response.
        await AdminAuditLog.Indexes.CreateOneAsync(new CreateIndexModel<AdminAuditLog>(
            Builders<AdminAuditLog>.IndexKeys.Ascending(e => e.ActorUserId),
            new CreateIndexOptions { Name = "idx_audit_actor" }));

        // demoRequests.status + .submittedAt — composite for the admin list
        // view, which sorts Pending first then by recency. Single compound
        // index satisfies both the equality filter (status == Pending) and
        // the sort, so the list endpoint stays O(log n) as the table grows.
        await DemoRequests.Indexes.CreateOneAsync(new CreateIndexModel<DemoRequest>(
            Builders<DemoRequest>.IndexKeys
                .Ascending(r => r.Status)
                .Descending(r => r.SubmittedAt),
            new CreateIndexOptions { Name = "idx_demo_status_submittedAt" }));

        // demoRequests.email — non-unique, used by the duplicate-submission
        // guard. Not unique because a previously rejected requester might
        // legitimately resubmit later.
        await DemoRequests.Indexes.CreateOneAsync(new CreateIndexModel<DemoRequest>(
            Builders<DemoRequest>.IndexKeys.Ascending(r => r.Email),
            new CreateIndexOptions { Name = "idx_demo_email" }));
    }

    private async Task UnsetNullSparseIndexFieldsAsync()
    {
        static FilterDefinition<T> ExistingNull<T>(string field)
        {
            var filter = Builders<T>.Filter;
            return filter.And(filter.Exists(field, true), filter.Type(field, BsonType.Null));
        }

        await Users.UpdateManyAsync(
            ExistingNull<User>("googleId"),
            Builders<User>.Update.Unset("googleId"));
        await Users.UpdateManyAsync(
            ExistingNull<User>("emailVerificationTokenLookup"),
            Builders<User>.Update.Unset("emailVerificationTokenLookup"));
        await Invitations.UpdateManyAsync(
            ExistingNull<Invitation>("tokenLookup"),
            Builders<Invitation>.Update.Unset("tokenLookup"));
        await InvitationLinks.UpdateManyAsync(
            ExistingNull<InvitationLink>("tokenLookup"),
            Builders<InvitationLink>.Update.Unset("tokenLookup"));
    }

    /// <summary>
    /// One-time backfill of User.ActiveLinkCount for users whose document predates
    /// the H7 fix (counter field is missing or null). Without this, the atomic
    /// quota gate in InvitationLinkService.GenerateLinkAsync silently rejects
    /// legacy users because Mongo's `{$lt: max}` doesn't match a missing field.
    ///
    /// Idempotent: only writes to users where the field is missing/null. Cost
    /// scales with user count (one Count per user) — fine for our 10s-of-users
    /// scale; revisit if we ever grow beyond ~10k users.
    /// </summary>
    public async Task BackfillActiveLinkCountsAsync()
    {
        // Pre-H7 docs lack the activeLinkCount field. Match both cases (missing
        // and explicit null) for safety.
        var filter = Builders<User>.Filter.Or(
            Builders<User>.Filter.Exists(u => u.ActiveLinkCount, false),
            Builders<User>.Filter.Eq(u => u.ActiveLinkCount, 0));

        // Only target legacy users — but a user with ActiveLinkCount = 0 AND
        // actual links would also need a fix. We keep the filter permissive (==0
        // OR missing) and only OVERWRITE when our computed count > 0, so users
        // who legitimately have zero active links aren't disturbed.
        var legacyUsers = await Users.Find(filter).ToListAsync();

        foreach (var user in legacyUsers)
        {
            // Count what counts against the quota:
            //   - Pending: not used, not returned, not expired
            //   - Truly used: UsedAt set (lifetime cap — stays in count forever)
            // Combined into one query for atomicity at the read.
            var now = DateTime.UtcNow;
            var count = await InvitationLinks.CountDocumentsAsync(l =>
                l.InviterUserId == user.Id &&
                !l.TicketReturned &&
                (l.UsedAt != null || l.ExpiresAt > now));

            if (count == 0) continue; // No links — leave at default 0.

            await Users.UpdateOneAsync(
                u => u.Id == user.Id,
                Builders<User>.Update.Set(u => u.ActiveLinkCount, (int)count));
        }
    }
}

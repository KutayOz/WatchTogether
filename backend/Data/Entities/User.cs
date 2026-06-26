using System.Text.Json.Serialization;
using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace WatchTogether.Data.Entities;

public class User
{
    [BsonId]
    [BsonRepresentation(BsonType.ObjectId)]
    public string Id { get; set; } = null!;

    [BsonElement("email")]
    public string Email { get; set; } = null!;

    [BsonElement("displayName")]
    public string DisplayName { get; set; } = null!;

    /// <summary>
    /// BCrypt hash. Nullable since Google-only users (signed up via
    /// Google Sign-In, never set a local password) won't have one.
    /// JsonIgnore is defense-in-depth — today no API endpoint serializes
    /// the raw User entity (everything goes through DTOs), but if a future
    /// contributor accidentally `return Ok(user)`'d we'd silently dump
    /// the password hash to the response. JsonIgnore makes that impossible.
    /// </summary>
    [BsonElement("passwordHash")]
    [BsonIgnoreIfNull]
    [JsonIgnore]
    public string? PasswordHash { get; set; }

    /// <summary>
    /// Google account subject claim (sub) for users who sign in via Google.
    /// Indexed unique sparse — null for password-only users, set+unique
    /// for Google users. A single user can have BOTH a password AND a
    /// linked Google account (we link by email match on first Google
    /// sign-in for an existing email-verified account).
    /// </summary>
    [BsonElement("googleId")]
    [BsonIgnoreIfNull]
    public string? GoogleId { get; set; }

    /// <summary>
    /// WebAuthn passkeys this user has registered. A single user can have
    /// multiple (one per device: laptop Touch ID + phone fingerprint + a
    /// YubiKey). Empty list = passkey login disabled for this user.
    ///
    /// Stored embedded — we never query individual credentials in isolation
    /// (we always load the user first via userHandle or email).
    /// </summary>
    [BsonElement("passkeyCredentials")]
    public List<StoredCredential> PasskeyCredentials { get; set; } = new();

    [BsonElement("createdAt")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    // Email verification
    [BsonElement("isEmailVerified")]
    public bool IsEmailVerified { get; set; } = false;

    [BsonElement("emailVerificationToken")]
    [BsonIgnoreIfNull]
    public string? EmailVerificationToken { get; set; }

    /// <summary>
    /// SHA-256 (hex) of the verification token. Indexed, unique, sparse. Fast lookup
    /// path — same pattern as InvitationLink.TokenLookup. Avoids O(n) BCrypt scan of
    /// all unverified users on every magic-link click.
    /// </summary>
    [BsonElement("emailVerificationTokenLookup")]
    [BsonIgnoreIfNull]
    public string? EmailVerificationTokenLookup { get; set; }

    [BsonElement("emailVerificationTokenExpiry")]
    [BsonIgnoreIfNull]
    public DateTime? EmailVerificationTokenExpiry { get; set; }

    // Invitation system
    [BsonElement("invitedByUserId")]
    [BsonRepresentation(BsonType.ObjectId)]
    [BsonIgnoreIfNull]
    public string? InvitedByUserId { get; set; }

    [BsonElement("isInvitationTicketUsed")]
    public bool IsInvitationTicketUsed { get; set; } = false;

    /// <summary>
    /// Atomic counter for H7 (slot-accounting TOCTOU fix). Mongo's
    /// FindOneAndUpdate with a $lt-filter + $inc on this field gives us
    /// a single-document atomic "if quota not exceeded then take a slot"
    /// operation — defeating the race where two concurrent generate-link
    /// requests both pass a non-atomic count check.
    ///
    /// Semantically equals: (pending InvitationLinks) + (truly-used
    /// InvitationLinks) for this user. Decremented when a link is revoked
    /// or expires (TicketReturned set). UI display still reads from the
    /// InvitationLinks collection — this counter is only the gate.
    /// </summary>
    [BsonElement("activeLinkCount")]
    public int ActiveLinkCount { get; set; } = 0;

    [BsonElement("isRootUser")]
    public bool IsRootUser { get; set; } = false;

    // Terms acceptance
    [BsonElement("acceptedTermsAt")]
    [BsonIgnoreIfNull]
    public DateTime? AcceptedTermsAt { get; set; }

    [BsonElement("termsVersion")]
    [BsonIgnoreIfNull]
    public string? TermsVersion { get; set; }

    /// <summary>
    /// Per-account login lockout. The IP-based rate limit (5/min in Program.cs)
    /// stops a single-source attack, but a distributed credential-stuffing run
    /// against this email goes around it. This counter tracks consecutive
    /// failures; AuthService uses exponential backoff and zeros it on success.
    /// </summary>
    [BsonElement("failedLoginAttempts")]
    public int FailedLoginAttempts { get; set; } = 0;

    /// <summary>
    /// When set in the future, login is blocked until this timestamp regardless
    /// of credentials. Cleared on successful login.
    /// </summary>
    [BsonElement("lockedUntil")]
    [BsonIgnoreIfNull]
    public DateTime? LockedUntil { get; set; }

    /// <summary>
    /// Soft-delete flag. Read methods filter on this by default; admin views
    /// can pass includeDeleted:true to see tombstoned rows. The document is
    /// kept (not removed) so foreign keys (InvitedByUserId on child users)
    /// remain pointing at a real row — the admin tree builder no longer
    /// silently drops grandchildren past a deleted parent.
    /// </summary>
    [BsonElement("isDeleted")]
    public bool IsDeleted { get; set; } = false;

    [BsonElement("deletedAt")]
    [BsonIgnoreIfNull]
    public DateTime? DeletedAt { get; set; }

    [BsonElement("deletedByUserId")]
    [BsonRepresentation(BsonType.ObjectId)]
    [BsonIgnoreIfNull]
    public string? DeletedByUserId { get; set; }
}

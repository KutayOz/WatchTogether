using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace WatchTogether.Data.Entities;

/// <summary>
/// Deny-list entry for a single JWT. Inserted when the user logs out (or an
/// admin forces revocation) and consulted by the JWT bearer middleware on
/// every authenticated request. The TTL index on ExpiresAt auto-prunes
/// entries after the JWT would have expired anyway — no manual cleanup.
/// </summary>
public class RevokedToken
{
    [BsonId]
    [BsonRepresentation(BsonType.ObjectId)]
    public string Id { get; set; } = null!;

    /// <summary>
    /// The JWT's `jti` claim (set per-token in AuthService.GenerateJwtToken).
    /// Unique-indexed so concurrent logouts from the same token are idempotent.
    /// </summary>
    [BsonElement("jti")]
    public string Jti { get; set; } = null!;

    /// <summary>
    /// The original JWT's `exp` time. TTL index reaps entries past this
    /// timestamp — they're moot once the token would have expired anyway.
    /// </summary>
    [BsonElement("expiresAt")]
    public DateTime ExpiresAt { get; set; }

    [BsonElement("revokedAt")]
    public DateTime RevokedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// User the revoked token belonged to. Lets a future "revoke all for user X"
    /// admin operation work — we'd add per-user tokenEpoch later if needed.
    /// </summary>
    [BsonElement("userId")]
    [BsonRepresentation(BsonType.ObjectId)]
    public string? UserId { get; set; }
}

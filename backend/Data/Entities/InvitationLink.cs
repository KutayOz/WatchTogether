using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace WatchTogether.Data.Entities;

public class InvitationLink
{
    [BsonId]
    [BsonRepresentation(BsonType.ObjectId)]
    public string Id { get; set; } = null!;

    /// <summary>
    /// BCrypt hash of the invitation token. Kept for legacy compatibility and as a
    /// defense-in-depth layer — if the DB leaks, the BCrypt hash still requires
    /// ~2^10 work per guess (though for 256-bit random tokens, brute force is
    /// infeasible regardless of hash strength).
    /// </summary>
    [BsonElement("tokenHash")]
    public string TokenHash { get; set; } = null!;

    /// <summary>
    /// SHA-256 (hex) of the invitation token. Indexed, unique, sparse. This is the
    /// fast lookup path: query by TokenLookup, find at most one document, then
    /// BCrypt.Verify the TokenHash against the provided token to confirm.
    ///
    /// Replaces the previous "fetch all unused links and BCrypt-verify against each"
    /// pattern, which was O(n) BCrypt ops per anonymous request → DoS amplifier.
    ///
    /// Why both fields: SHA-256 is fast and deterministic (you can look up by it),
    /// BCrypt is slow and salted (resistant to mass cracking if the DB leaks). For
    /// high-entropy random tokens BCrypt adds little; we keep it for graceful
    /// migration of any legacy rows.
    /// </summary>
    [BsonElement("tokenLookup")]
    [BsonIgnoreIfNull]
    public string? TokenLookup { get; set; }

    /// <summary>
    /// User who generated this invitation link (used their ticket)
    /// </summary>
    [BsonElement("inviterUserId")]
    [BsonRepresentation(BsonType.ObjectId)]
    public string InviterUserId { get; set; } = null!;

    [BsonElement("createdAt")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// Link expires 15 minutes after creation
    /// </summary>
    [BsonElement("expiresAt")]
    public DateTime ExpiresAt { get; set; }

    /// <summary>
    /// When the link was used (null = not used yet)
    /// </summary>
    [BsonElement("usedAt")]
    [BsonIgnoreIfNull]
    public DateTime? UsedAt { get; set; }

    /// <summary>
    /// The user who registered using this link
    /// </summary>
    [BsonElement("usedByUserId")]
    [BsonRepresentation(BsonType.ObjectId)]
    [BsonIgnoreIfNull]
    public string? UsedByUserId { get; set; }

    /// <summary>
    /// If true, the ticket was returned to the inviter after expiry
    /// </summary>
    [BsonElement("ticketReturned")]
    public bool TicketReturned { get; set; } = false;
}

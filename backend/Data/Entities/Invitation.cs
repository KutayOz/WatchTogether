using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace WatchTogether.Data.Entities;

public enum InvitationStatus
{
    Pending,
    Used,
    Expired,
    Revoked
}

public class Invitation
{
    [BsonId]
    [BsonRepresentation(BsonType.ObjectId)]
    public string Id { get; set; } = null!;

    [BsonElement("inviterUserId")]
    [BsonRepresentation(BsonType.ObjectId)]
    public string InviterUserId { get; set; } = null!;

    [BsonElement("inviteeEmail")]
    public string InviteeEmail { get; set; } = null!;

    /// <summary>
    /// BCrypt hash of the invitation token (since the medium-batch hardening).
    /// Previously stored as plaintext, which meant an Atlas backup leak made all
    /// pending invitation tokens replayable. The token itself only exists in the
    /// email body sent to the invitee.
    /// </summary>
    [BsonElement("invitationToken")]
    public string InvitationToken { get; set; } = null!;

    /// <summary>
    /// SHA-256 (hex) of the invitation token. Indexed, unique, sparse — same
    /// fast-lookup pattern as InvitationLink.TokenLookup. Without it, lookup
    /// from a hashed InvitationToken would require BCrypt-verifying against
    /// every row.
    /// </summary>
    [BsonElement("tokenLookup")]
    [BsonIgnoreIfNull]
    public string? TokenLookup { get; set; }

    [BsonElement("status")]
    public InvitationStatus Status { get; set; } = InvitationStatus.Pending;

    [BsonElement("createdAt")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    [BsonElement("expiresAt")]
    public DateTime ExpiresAt { get; set; }

    [BsonElement("usedAt")]
    [BsonIgnoreIfNull]
    public DateTime? UsedAt { get; set; }

    [BsonElement("registeredUserId")]
    [BsonRepresentation(BsonType.ObjectId)]
    [BsonIgnoreIfNull]
    public string? RegisteredUserId { get; set; }
}

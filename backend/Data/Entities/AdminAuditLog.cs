using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace WatchTogether.Data.Entities;

/// <summary>
/// Append-only forensic record of state-changing admin actions. With this
/// in place, a compromised root account can't silently mutate the system —
/// every Update/Delete leaves a trail (actor, action, target, timestamp, IP).
/// Not exposed via a UI endpoint yet; admins query via Atlas when needed.
/// </summary>
public class AdminAuditLog
{
    [BsonId]
    [BsonRepresentation(BsonType.ObjectId)]
    public string Id { get; set; } = null!;

    /// <summary>The admin user who performed the action.</summary>
    [BsonElement("actorUserId")]
    [BsonRepresentation(BsonType.ObjectId)]
    public string ActorUserId { get; set; } = null!;

    /// <summary>Snapshot of the actor's email at the time of the action.
    /// Stored independently of the user collection so a later anonymization
    /// of the actor doesn't erase the audit context.</summary>
    [BsonElement("actorEmail")]
    public string? ActorEmail { get; set; }

    /// <summary>Action name — "UpdateUser", "DeleteUser", "DeleteInvitation", etc.
    /// Free-text rather than enum so a new admin endpoint can record a new
    /// action without a schema migration.</summary>
    [BsonElement("action")]
    public string Action { get; set; } = null!;

    /// <summary>"User" or "Invitation" — narrows the scope of TargetId.</summary>
    [BsonElement("targetType")]
    public string TargetType { get; set; } = null!;

    [BsonElement("targetId")]
    [BsonRepresentation(BsonType.ObjectId)]
    public string TargetId { get; set; } = null!;

    /// <summary>Free-form JSON-ish details about the change. Optional; useful
    /// for UpdateUser to capture the before/after for each modified field.</summary>
    [BsonElement("details")]
    public string? Details { get; set; }

    /// <summary>Client IP at the time of the action. Read from the request
    /// after the forwarded-headers middleware has rewritten it (H5 fix).</summary>
    [BsonElement("ipAddress")]
    public string? IpAddress { get; set; }

    [BsonElement("timestamp")]
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;
}

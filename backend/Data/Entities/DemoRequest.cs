using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace WatchTogether.Data.Entities;

public enum DemoRequestStatus
{
    Pending,
    Approved,
    Rejected
}

/// <summary>
/// Public guest submits the form on /request-demo. Lands here as Pending.
/// Root user reviews in the admin dashboard and either Approves (which
/// generates a single-use InvitationLink + emails the requester) or Rejects.
/// </summary>
public class DemoRequest
{
    [BsonId]
    [BsonRepresentation(BsonType.ObjectId)]
    public string Id { get; set; } = null!;

    [BsonElement("email")]
    public string Email { get; set; } = null!;

    [BsonElement("displayName")]
    public string DisplayName { get; set; } = null!;

    /// <summary>
    /// Free-form "why do you want to try this?" — optional. Hard-capped at
    /// 500 chars at the controller so an attacker can't bloat the DB with
    /// novel-length submissions from an anonymous endpoint.
    /// </summary>
    [BsonElement("message")]
    [BsonIgnoreIfNull]
    public string? Message { get; set; }

    [BsonElement("status")]
    public DemoRequestStatus Status { get; set; } = DemoRequestStatus.Pending;

    [BsonElement("submittedAt")]
    public DateTime SubmittedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// IP at submission time. Kept for forensics — if the request looks like
    /// spam we can audit-trace it. Forwarded-headers middleware has already
    /// rewritten this to the real client IP, not the edge proxy's.
    /// </summary>
    [BsonElement("submittedFromIp")]
    [BsonIgnoreIfNull]
    public string? SubmittedFromIp { get; set; }

    [BsonElement("reviewedAt")]
    [BsonIgnoreIfNull]
    public DateTime? ReviewedAt { get; set; }

    [BsonElement("reviewedByUserId")]
    [BsonRepresentation(BsonType.ObjectId)]
    [BsonIgnoreIfNull]
    public string? ReviewedByUserId { get; set; }

    /// <summary>
    /// On Approve: id of the InvitationLink that was generated for this
    /// requester. Lets the admin see "approved → link issued" in the audit
    /// trail without joining tables.
    /// </summary>
    [BsonElement("invitationLinkId")]
    [BsonRepresentation(BsonType.ObjectId)]
    [BsonIgnoreIfNull]
    public string? InvitationLinkId { get; set; }

    /// <summary>
    /// On Reject: optional reason the admin recorded. Internal-only, not
    /// surfaced to the requester (the rejection itself is silent — we don't
    /// email "you got rejected" to avoid being an enumeration oracle).
    /// </summary>
    [BsonElement("rejectionReason")]
    [BsonIgnoreIfNull]
    public string? RejectionReason { get; set; }
}

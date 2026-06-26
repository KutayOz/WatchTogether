using WatchTogether.Data.Entities;

namespace WatchTogether.Business.Services;

public class SubmitDemoRequestResult
{
    public bool Success { get; set; }
    public string? Message { get; set; }
}

public class ApproveDemoRequestResult
{
    public bool Success { get; set; }
    public string? Message { get; set; }
    public string? InvitationUrl { get; set; }
    public DateTime? ExpiresAt { get; set; }
}

public interface IDemoRequestService
{
    /// <summary>
    /// Anonymous submission from the /request-demo page. Always returns Success
    /// for any well-formed input (including emails we've already seen) to avoid
    /// being an enumeration oracle — the duplicate guard runs inside but the
    /// public response is uniform.
    /// </summary>
    Task<SubmitDemoRequestResult> SubmitAsync(
        string email,
        string displayName,
        string? message,
        string? clientIp);

    /// <summary>
    /// List all demo requests, sorted Pending first then by recency.
    /// Admin-only — caller enforces auth.
    /// </summary>
    Task<List<DemoRequest>> ListAsync();

    /// <summary>
    /// Approve a pending request: generate a one-time InvitationLink under the
    /// approving admin's slot pool, email the requester, mark the request
    /// Approved. Idempotent on re-approve attempts (returns the same outcome
    /// as the first approve — no double-link).
    /// </summary>
    Task<ApproveDemoRequestResult> ApproveAsync(string requestId, string approverUserId);

    /// <summary>
    /// Reject a pending request. Silent — no email goes out (avoids being an
    /// enumeration oracle for "is this email known to the system"). Optional
    /// internal reason is recorded for the audit trail.
    /// </summary>
    Task<bool> RejectAsync(string requestId, string approverUserId, string? reason);

    /// <summary>
    /// Re-issue a fresh invitation link for an already-Approved request and
    /// re-send the approval email. The original link stays valid until its own
    /// expiry — both can be used; the requester just uses whichever email
    /// arrived. Useful when the first email bounced, was missed, or the link
    /// already expired.
    /// </summary>
    Task<ApproveDemoRequestResult> ResendInviteAsync(string requestId, string actorUserId);
}

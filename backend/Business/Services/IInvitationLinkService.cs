using WatchTogether.Data.Entities;

namespace WatchTogether.Business.Services;

public class GenerateLinkResult
{
    public bool Success { get; set; }
    public string? Message { get; set; }
    public string? InviteUrl { get; set; }
    public DateTime? ExpiresAt { get; set; }
}

public class ValidateLinkResult
{
    public bool Valid { get; set; }
    public string? Message { get; set; }
    public string? InviterUserId { get; set; }
    public string? InvitationLinkId { get; set; }
}

public interface IInvitationLinkService
{
    /// <summary>
    /// Generate a shareable invitation link (uses user's ticket)
    /// </summary>
    Task<GenerateLinkResult> GenerateLinkAsync(string inviterUserId);

    /// <summary>
    /// Validate an invitation token (called when friend clicks link)
    /// </summary>
    Task<ValidateLinkResult> ValidateLinkAsync(string token);

    /// <summary>
    /// Mark invitation link as used after successful registration
    /// </summary>
    Task MarkLinkUsedAsync(string linkId, string registeredUserId);

    /// <summary>
    /// Get active link for a user (if any)
    /// </summary>
    Task<InvitationLink?> GetActiveLinkAsync(string userId);

    /// <summary>
    /// Revoke an active invitation link (returns ticket to user)
    /// </summary>
    Task<(bool Success, string Message)> RevokeLinkAsync(string userId);

    /// <summary>
    /// Process expired links and return tickets to inviters
    /// </summary>
    Task<int> ReturnExpiredTicketsAsync();
}

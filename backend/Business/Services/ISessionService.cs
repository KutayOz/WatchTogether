using WatchTogether.Business.Models;

namespace WatchTogether.Business.Services;

public class GenerateSessionInviteResult
{
    public bool Success { get; set; }
    public string? Message { get; set; }
    public string? InviteUrl { get; set; }
    public string? Token { get; set; }
    public DateTime? ExpiresAt { get; set; }
}

public class ValidateSessionInviteResult
{
    public bool Valid { get; set; }
    public string? Message { get; set; }
    public string? SessionId { get; set; }
    public string? CreatorDisplayName { get; set; }
}

public interface ISessionService
{
    string CreateSession(string creatorUserId);
    Session? GetSession(string sessionId);
    bool SessionExists(string sessionId);
    bool AddParticipant(string sessionId, string connectionId, string email, string displayName);
    void RemoveParticipant(string sessionId, string connectionId);
    int GetParticipantCount(string sessionId);
    List<Participant> GetOtherParticipants(string sessionId, string excludeConnectionId);
    /// <summary>
    /// Build the ICE server list for a given user. Preferred path: Cloudflare
    /// Realtime TURN — when WebRTC:CloudflareTurnKeyId + CloudflareTurnApiToken are
    /// set, short-lived credentials are minted via the Cloudflare API. Otherwise:
    /// WebRTC:TurnAuthSecret mints coturn time-bound credentials, or a static
    /// username/credential from config is used (legacy). Async because the
    /// Cloudflare path makes an outbound HTTP call.
    /// </summary>
    Task<IceServerConfig> GetIceServersAsync(string userId);

    // Session invite methods
    GenerateSessionInviteResult GenerateInvite(string sessionId, string userId, string frontendUrl);
    ValidateSessionInviteResult ValidateInvite(string token);
    /// <summary>
    /// Atomically mark a session invite as used. Returns true iff this call
    /// won the race; false if the invite was already consumed. Callers must
    /// check the return to enforce single-use semantics.
    /// </summary>
    bool MarkInviteUsed(string token, string userId);

    // Periodic-cleanup hooks (called by SessionCleanupHostedService).
    // Public so a background timer can drive cleanup independently of write traffic —
    // previously cleanup only ran on CreateSession/GenerateInvite, leaking during quiet periods.
    int RunSessionCleanup();
    int RunInviteCleanup();
}

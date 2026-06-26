namespace WatchTogether.Business.Models;

public class Session
{
    public string Id { get; set; } = null!;
    public string CreatorUserId { get; set; } = null!;
    public List<Participant> Participants { get; set; } = new();
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? EmptySince { get; set; } = null; // When session became empty (for cleanup)
}

public class Participant
{
    public string ConnectionId { get; set; } = null!;
    public string Email { get; set; } = null!;
    public string DisplayName { get; set; } = null!;
}

/// <summary>
/// One-time invite link for joining a session
/// </summary>
public class SessionInvite
{
    public string Token { get; set; } = null!;
    public string SessionId { get; set; } = null!;
    public string CreatedByUserId { get; set; } = null!;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; }

    /// <summary>
    /// Atomic single-use flag. 0 = not used, 1 = used. We use an int field
    /// (not a bool property) because Interlocked.CompareExchange requires
    /// a ref to a writeable field — the only way two concurrent JoinWithInvite
    /// callers can be reliably resolved to a single winner without locking
    /// the whole invite dictionary. See MarkInviteUsed in SessionService.
    /// </summary>
    public int UsedFlag;

    /// <summary>Convenience read-only view of UsedFlag.</summary>
    public bool IsUsed => UsedFlag != 0;

    public string? UsedByUserId { get; set; }
}

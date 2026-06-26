namespace WatchTogether.Business.DTOs;

public class CreateSessionResponse
{
    public string SessionId { get; set; } = null!;
}

public class ValidateSessionResponse
{
    public bool Exists { get; set; }
    public bool Valid { get; set; }
    public int ParticipantCount { get; set; }
}

// Session invite DTOs
public class SessionInviteResponse
{
    public bool Success { get; set; }
    public string? InviteUrl { get; set; }
    public DateTime? ExpiresAt { get; set; }
}

public class ValidateSessionInviteResponse
{
    public bool Valid { get; set; }
    public string? Message { get; set; }
    public string? SessionId { get; set; }
    public string? CreatorDisplayName { get; set; }
}

public class JoinWithInviteResponse
{
    public bool Success { get; set; }
    public string? SessionId { get; set; }
}

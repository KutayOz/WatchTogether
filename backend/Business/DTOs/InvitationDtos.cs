namespace WatchTogether.Business.DTOs;

public class CreateInvitationRequest
{
    public string Email { get; set; } = null!;
}

public class InvitationDto
{
    public string Id { get; set; } = null!;
    public string InviteeEmail { get; set; } = null!;
    public string Status { get; set; } = null!;
    public DateTime CreatedAt { get; set; }
    public DateTime ExpiresAt { get; set; }
    public DateTime? UsedAt { get; set; }
}

public class InvitationSlotsResponse
{
    public int MaxSlots { get; set; }
    public int UsedSlots { get; set; }
    /// <summary>Outstanding (generated, not yet consumed, not expired) link count.</summary>
    public int PendingSlots { get; set; }
    /// <summary>Links a friend has already registered through.</summary>
    public int TrulyUsedSlots { get; set; }
    public int RemainingSlots { get; set; }
    /// <summary>True for root admin — quota is uncapped (MaxSlots holds int.MaxValue
    /// as a sentinel, not a meaningful number). The frontend MUST check this flag
    /// before iterating MaxSlots; otherwise it would try to render ~2 billion
    /// ticket nodes and crash the tab. Without this field the Lobby tile loop
    /// (`Array.from({length: maxSlots})`) does exactly that — caught while
    /// debugging a "loading tickets…" hang after root login.</summary>
    public bool IsUnlimited { get; set; }
}

public class CreateInvitationResponse
{
    public bool Success { get; set; }
    public string? Message { get; set; }
    public string? InvitationLink { get; set; }
    public InvitationDto? Invitation { get; set; }
}

// New link-based invitation DTOs

public class GenerateLinkResponse
{
    public bool Success { get; set; }
    public string? Message { get; set; }
    public string? InviteUrl { get; set; }
    public DateTime? ExpiresAt { get; set; }
}

public class ValidateLinkResponse
{
    public bool Valid { get; set; }
    public string? Message { get; set; }
    public string? InviterDisplayName { get; set; }
}

public class ActiveLinkResponse
{
    public bool HasActiveLink { get; set; }
    public string? InviteUrl { get; set; }
    public DateTime? ExpiresAt { get; set; }
}

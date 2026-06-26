using WatchTogether.Data.Entities;

namespace WatchTogether.Business.Services;

public class InvitationSlotInfo
{
    public int MaxSlots { get; set; }
    /// <summary>Total slots taken — sum of PendingSlots + TrulyUsedSlots.</summary>
    public int UsedSlots { get; set; }
    /// <summary>Outstanding links (generated, not yet consumed, not expired).</summary>
    public int PendingSlots { get; set; }
    /// <summary>Links a friend has already registered through (UsedAt is set).</summary>
    public int TrulyUsedSlots { get; set; }
    public int RemainingSlots { get; set; }
    /// <summary>
    /// True when the user has no quota cap (root). In that case MaxSlots and
    /// RemainingSlots both carry the sentinel <see cref="int.MaxValue"/> — the
    /// frontend should render "∞" instead of the raw number. UsedSlots /
    /// PendingSlots / TrulyUsedSlots stay accurate so the UI can still show
    /// "who you actually invited."
    /// </summary>
    public bool IsUnlimited { get; set; }
}

public class CreateInvitationResult
{
    public bool Success { get; set; }
    public string? Message { get; set; }
    public string? InvitationLink { get; set; }
    public Invitation? Invitation { get; set; }
}

public interface IInvitationService
{
    Task<InvitationSlotInfo> GetAvailableSlotsAsync(string userId);
    Task<CreateInvitationResult> CreateInvitationAsync(string inviterUserId, string inviteeEmail);
    Task<List<Invitation>> GetMyInvitationsAsync(string userId);
    Task<List<Invitation>> GetAllInvitationsAsync();
    Task<(bool Success, string Message)> RevokeInvitationAsync(string invitationId, string userId);
}

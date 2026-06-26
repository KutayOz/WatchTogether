using WatchTogether.Data.Entities;

namespace WatchTogether.Data.Repositories;

public interface IInvitationLinkRepository
{
    Task<InvitationLink?> GetByIdAsync(string id);
    Task<List<InvitationLink>> GetByInviterUserIdAsync(string inviterUserId);
    Task<InvitationLink?> GetActiveByInviterUserIdAsync(string inviterUserId);
    Task<List<InvitationLink>> GetExpiredUnusedLinksAsync();
    Task<List<InvitationLink>> GetAllUnusedLinksAsync();
    /// <summary>
    /// Fast O(1) lookup of an invitation link by the SHA-256 hex of its token.
    /// Replaces the O(n) BCrypt scan over all unused links on the anonymous
    /// validate endpoint.
    /// </summary>
    Task<InvitationLink?> GetByTokenLookupAsync(string tokenLookup);
    Task<InvitationLink> CreateAsync(InvitationLink link);
    Task<InvitationLink> UpdateAsync(InvitationLink link);
    Task<bool> DeleteAsync(string id);

    /// <summary>
    /// Count outstanding (pending) invitation links — currently active (unused,
    /// unexpired, ticket not returned). Expired and revoked links do not count.
    /// </summary>
    Task<long> CountPendingByInviterAsync(string inviterUserId);

    /// <summary>
    /// Count invitation links that have been truly consumed — a friend
    /// successfully registered via the link (UsedAt is set). These count as
    /// permanently spent gifts and never return the slot.
    /// </summary>
    Task<long> CountTrulyUsedByInviterAsync(string inviterUserId);
}

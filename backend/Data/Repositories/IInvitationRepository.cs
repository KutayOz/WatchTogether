using WatchTogether.Data.Entities;

namespace WatchTogether.Data.Repositories;

public interface IInvitationRepository
{
    Task<Invitation?> GetByIdAsync(string id);
    Task<Invitation?> GetByTokenAsync(string token);
    /// <summary>
    /// Fast O(1) lookup of an invitation by SHA-256 hex of its plaintext token.
    /// Use this instead of GetByTokenAsync when the token has been hashed at rest.
    /// </summary>
    Task<Invitation?> GetByTokenLookupAsync(string tokenLookup);
    Task<List<Invitation>> GetByInviterUserIdAsync(string inviterUserId);
    Task<List<Invitation>> GetAllAsync();
    Task<int> GetUsedCountByInviterAsync(string inviterUserId);
    Task<Invitation> CreateAsync(Invitation invitation);
    Task<Invitation> UpdateAsync(Invitation invitation);
    Task<bool> DeleteAsync(string id);
}

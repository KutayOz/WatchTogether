using WatchTogether.Data.Entities;

namespace WatchTogether.Data.Repositories;

public interface IRevokedTokenRepository
{
    /// <summary>
    /// True if the JWT identified by this jti is on the deny list.
    /// Called on every authenticated request, so should be a single
    /// indexed point query (we have a unique index on jti).
    /// </summary>
    Task<bool> IsRevokedAsync(string jti);

    /// <summary>
    /// Add a token to the deny list. Idempotent — a duplicate-key
    /// from a concurrent logout is swallowed (already revoked = goal achieved).
    /// </summary>
    Task RevokeAsync(RevokedToken entry);
}

using MongoDB.Driver;
using WatchTogether.Data.Context;
using WatchTogether.Data.Entities;

namespace WatchTogether.Data.Repositories;

public class InvitationLinkRepository : IInvitationLinkRepository
{
    private readonly MongoDbContext _context;

    public InvitationLinkRepository(MongoDbContext context)
    {
        _context = context;
    }

    public async Task<InvitationLink?> GetByIdAsync(string id)
    {
        return await _context.InvitationLinks
            .Find(l => l.Id == id)
            .FirstOrDefaultAsync();
    }

    public async Task<List<InvitationLink>> GetByInviterUserIdAsync(string inviterUserId)
    {
        return await _context.InvitationLinks
            .Find(l => l.InviterUserId == inviterUserId)
            .SortByDescending(l => l.CreatedAt)
            .ToListAsync();
    }

    /// <summary>
    /// Get active (not expired, not used) link for an inviter
    /// </summary>
    public async Task<InvitationLink?> GetActiveByInviterUserIdAsync(string inviterUserId)
    {
        var now = DateTime.UtcNow;
        return await _context.InvitationLinks
            .Find(l => l.InviterUserId == inviterUserId &&
                       l.ExpiresAt > now &&
                       l.UsedAt == null)
            .FirstOrDefaultAsync();
    }

    /// <summary>
    /// Get links that have expired but ticket hasn't been returned yet
    /// </summary>
    public async Task<List<InvitationLink>> GetExpiredUnusedLinksAsync()
    {
        var now = DateTime.UtcNow;
        return await _context.InvitationLinks
            .Find(l => l.ExpiresAt <= now &&
                       l.UsedAt == null &&
                       !l.TicketReturned)
            .ToListAsync();
    }

    /// <summary>
    /// Get all unused links (for token validation - need to check hash).
    /// Legacy path — new code should use GetByTokenLookupAsync for O(1) lookup.
    /// Still in place to handle any pre-migration rows lacking TokenLookup.
    /// </summary>
    public async Task<List<InvitationLink>> GetAllUnusedLinksAsync()
    {
        return await _context.InvitationLinks
            .Find(l => l.UsedAt == null && !l.TicketReturned)
            .ToListAsync();
    }

    public async Task<InvitationLink?> GetByTokenLookupAsync(string tokenLookup)
    {
        return await _context.InvitationLinks
            .Find(l => l.TokenLookup == tokenLookup)
            .FirstOrDefaultAsync();
    }

    public async Task<InvitationLink> CreateAsync(InvitationLink link)
    {
        await _context.InvitationLinks.InsertOneAsync(link);
        return link;
    }

    public async Task<InvitationLink> UpdateAsync(InvitationLink link)
    {
        await _context.InvitationLinks.ReplaceOneAsync(l => l.Id == link.Id, link);
        return link;
    }

    public async Task<bool> DeleteAsync(string id)
    {
        var result = await _context.InvitationLinks.DeleteOneAsync(l => l.Id == id);
        return result.DeletedCount > 0;
    }

    public async Task<long> CountPendingByInviterAsync(string inviterUserId)
    {
        // Pending = generated, not yet consumed, not yet expired, not returned.
        // Expired/revoked links don't take a slot; the inviter can re-issue.
        var now = DateTime.UtcNow;
        return await _context.InvitationLinks.CountDocumentsAsync(l =>
            l.InviterUserId == inviterUserId &&
            l.UsedAt == null &&
            l.ExpiresAt > now &&
            !l.TicketReturned);
    }

    public async Task<long> CountTrulyUsedByInviterAsync(string inviterUserId)
    {
        // Truly used = a friend successfully registered through this link.
        // The slot is permanently spent — gift model, not concurrent capacity.
        // Filter is intentionally minimal: UsedAt being set is the source of truth,
        // regardless of expiry or any other flag.
        return await _context.InvitationLinks.CountDocumentsAsync(l =>
            l.InviterUserId == inviterUserId &&
            l.UsedAt != null);
    }
}

using MongoDB.Driver;
using WatchTogether.Data.Context;
using WatchTogether.Data.Entities;

namespace WatchTogether.Data.Repositories;

public class InvitationRepository : IInvitationRepository
{
    private readonly MongoDbContext _context;

    public InvitationRepository(MongoDbContext context)
    {
        _context = context;
    }

    public async Task<Invitation?> GetByIdAsync(string id)
    {
        return await _context.Invitations
            .Find(i => i.Id == id)
            .FirstOrDefaultAsync();
    }

    /// <summary>
    /// Legacy lookup by plaintext token. Kept on the interface for any caller
    /// that still passes a hashed value through, but the canonical lookup path
    /// is now <see cref="GetByTokenLookupAsync"/> after the legacy invitation
    /// hashing change.
    /// </summary>
    public async Task<Invitation?> GetByTokenAsync(string token)
    {
        return await _context.Invitations
            .Find(i => i.InvitationToken == token)
            .FirstOrDefaultAsync();
    }

    public async Task<Invitation?> GetByTokenLookupAsync(string tokenLookup)
    {
        return await _context.Invitations
            .Find(i => i.TokenLookup == tokenLookup)
            .FirstOrDefaultAsync();
    }

    public async Task<List<Invitation>> GetByInviterUserIdAsync(string inviterUserId)
    {
        return await _context.Invitations
            .Find(i => i.InviterUserId == inviterUserId)
            .SortByDescending(i => i.CreatedAt)
            .ToListAsync();
    }

    public async Task<List<Invitation>> GetAllAsync()
    {
        return await _context.Invitations
            .Find(_ => true)
            .SortByDescending(i => i.CreatedAt)
            .ToListAsync();
    }

    public async Task<int> GetUsedCountByInviterAsync(string inviterUserId)
    {
        return (int)await _context.Invitations
            .CountDocumentsAsync(i =>
                i.InviterUserId == inviterUserId &&
                (i.Status == InvitationStatus.Used || i.Status == InvitationStatus.Pending));
    }

    public async Task<Invitation> CreateAsync(Invitation invitation)
    {
        await _context.Invitations.InsertOneAsync(invitation);
        return invitation;
    }

    public async Task<Invitation> UpdateAsync(Invitation invitation)
    {
        await _context.Invitations.ReplaceOneAsync(i => i.Id == invitation.Id, invitation);
        return invitation;
    }

    public async Task<bool> DeleteAsync(string id)
    {
        var result = await _context.Invitations.DeleteOneAsync(i => i.Id == id);
        return result.DeletedCount > 0;
    }
}

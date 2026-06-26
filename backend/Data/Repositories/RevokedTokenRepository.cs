using MongoDB.Driver;
using WatchTogether.Data.Context;
using WatchTogether.Data.Entities;

namespace WatchTogether.Data.Repositories;

public class RevokedTokenRepository : IRevokedTokenRepository
{
    private readonly MongoDbContext _context;

    public RevokedTokenRepository(MongoDbContext context)
    {
        _context = context;
    }

    public async Task<bool> IsRevokedAsync(string jti)
    {
        // Single indexed point query via the unique index on jti (uniq_jti).
        // FindOneAsync returns null if not present; we only need existence so
        // CountDocuments would also work, but Find is slightly cheaper because
        // it stops at the first match.
        var match = await _context.RevokedTokens
            .Find(t => t.Jti == jti)
            .Project(t => t.Id) // project to just the id — fastest path
            .FirstOrDefaultAsync();
        return match != null;
    }

    public async Task RevokeAsync(RevokedToken entry)
    {
        try
        {
            await _context.RevokedTokens.InsertOneAsync(entry);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            // Already revoked — that's the desired state, so swallow.
            // A concurrent logout from another tab is the typical cause.
        }
    }
}

using MongoDB.Driver;
using WatchTogether.Data.Context;
using WatchTogether.Data.Entities;

namespace WatchTogether.Data.Repositories;

public class AdminAuditLogRepository : IAdminAuditLogRepository
{
    private readonly MongoDbContext _context;

    public AdminAuditLogRepository(MongoDbContext context)
    {
        _context = context;
    }

    public Task AppendAsync(AdminAuditLog entry)
    {
        // Append-only — no UpdateAsync / DeleteAsync exposed. The audit log's
        // value comes from being tamper-evident at the application layer;
        // anything that mutates it is suspicious by design. Atlas itself can
        // of course modify it, but that's outside the app's threat model.
        return _context.AdminAuditLog.InsertOneAsync(entry);
    }

    public async Task<List<AdminAuditLog>> GetRecentAsync(int limit = 100)
    {
        return await _context.AdminAuditLog
            .Find(_ => true)
            .SortByDescending(e => e.Timestamp)
            .Limit(limit)
            .ToListAsync();
    }
}

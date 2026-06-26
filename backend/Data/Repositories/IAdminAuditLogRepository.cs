using WatchTogether.Data.Entities;

namespace WatchTogether.Data.Repositories;

public interface IAdminAuditLogRepository
{
    Task AppendAsync(AdminAuditLog entry);
    Task<List<AdminAuditLog>> GetRecentAsync(int limit = 100);
}

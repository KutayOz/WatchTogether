using MongoDB.Driver;
using WatchTogether.Data.Context;
using WatchTogether.Data.Entities;

namespace WatchTogether.Data.Repositories;

public class DemoRequestRepository : IDemoRequestRepository
{
    private readonly MongoDbContext _context;

    public DemoRequestRepository(MongoDbContext context)
    {
        _context = context;
    }

    public async Task<DemoRequest?> GetByIdAsync(string id)
    {
        return await _context.DemoRequests
            .Find(r => r.Id == id)
            .FirstOrDefaultAsync();
    }

    public async Task<List<DemoRequest>> GetAllAsync()
    {
        // Pending first (most urgent for the admin to action), then by recency.
        // Composite sort instead of two queries — Mongo can satisfy both keys
        // from the same plan.
        return await _context.DemoRequests
            .Find(_ => true)
            .Sort(Builders<DemoRequest>.Sort.Ascending(r => r.Status).Descending(r => r.SubmittedAt))
            .ToListAsync();
    }

    public async Task<bool> HasPendingByEmailAsync(string email)
    {
        return await _context.DemoRequests
            .Find(r => r.Email == email && r.Status == DemoRequestStatus.Pending)
            .AnyAsync();
    }

    public async Task<DemoRequest> CreateAsync(DemoRequest request)
    {
        await _context.DemoRequests.InsertOneAsync(request);
        return request;
    }

    public async Task<DemoRequest> UpdateAsync(DemoRequest request)
    {
        await _context.DemoRequests.ReplaceOneAsync(r => r.Id == request.Id, request);
        return request;
    }

    public async Task<int> CountByStatusAsync(DemoRequestStatus status)
    {
        return (int)await _context.DemoRequests.CountDocumentsAsync(r => r.Status == status);
    }
}

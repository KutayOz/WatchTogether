using WatchTogether.Data.Entities;

namespace WatchTogether.Data.Repositories;

public interface IDemoRequestRepository
{
    Task<DemoRequest?> GetByIdAsync(string id);
    Task<List<DemoRequest>> GetAllAsync();

    /// <summary>
    /// True if there's already a Pending demo request from this email.
    /// Used to short-circuit duplicate submissions without leaking which
    /// emails are in the system (we return the same "submitted" response
    /// either way to avoid an enumeration oracle).
    /// </summary>
    Task<bool> HasPendingByEmailAsync(string email);

    Task<DemoRequest> CreateAsync(DemoRequest request);
    Task<DemoRequest> UpdateAsync(DemoRequest request);

    /// <summary>
    /// Count requests in a given status. Surfaces as a "pending" badge in the
    /// admin tab without paying for a full list query.
    /// </summary>
    Task<int> CountByStatusAsync(DemoRequestStatus status);
}

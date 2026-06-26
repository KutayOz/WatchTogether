using MongoDB.Driver;
using WatchTogether.Data.Context;
using WatchTogether.Data.Entities;

namespace WatchTogether.Data.Repositories;

public class UserRepository : IUserRepository
{
    private readonly MongoDbContext _context;

    public UserRepository(MongoDbContext context)
    {
        _context = context;
    }

    // All read paths below default to excluding soft-deleted users — a deleted
    // user should not be able to log in, register a duplicate email, validate
    // an old verification token, etc. GetAllAsync and GetInvitedByUserAsync
    // remain unfiltered because admin views and the user tree builder need the
    // full picture (an admin "[deleted] X" entry, not an orphaned hole).

    public async Task<User?> GetByIdAsync(string id)
    {
        return await _context.Users
            .Find(u => u.Id == id && !u.IsDeleted)
            .FirstOrDefaultAsync();
    }

    public async Task<User?> GetByEmailAsync(string email)
    {
        // Emails are stored lowercase (normalized in services on insert). Normalizing
        // the parameter on the way in lets the unique index on email be used — the
        // previous u.Email.ToLower() forced a $toLower expression that bypassed it.
        // ToLowerInvariant (not ToLower) so a tr-TR-locale server doesn't lower "I"
        // → "ı" and lose a real match.
        var normalized = email.ToLowerInvariant().Trim();
        return await _context.Users
            .Find(u => u.Email == normalized && !u.IsDeleted)
            .FirstOrDefaultAsync();
    }

    public async Task<User?> GetByGoogleIdAsync(string googleId)
    {
        return await _context.Users
            .Find(u => u.GoogleId == googleId && !u.IsDeleted)
            .FirstOrDefaultAsync();
    }

    public async Task<User?> GetByPasskeyCredentialIdAsync(byte[] credentialId)
    {
        // ElemMatch on the embedded PasskeyCredentials array — matches any
        // user whose credentials list contains a doc with this CredentialId.
        var filter = Builders<User>.Filter.And(
            Builders<User>.Filter.ElemMatch(u => u.PasskeyCredentials, c => c.CredentialId == credentialId),
            Builders<User>.Filter.Eq(u => u.IsDeleted, false)
        );
        return await _context.Users.Find(filter).FirstOrDefaultAsync();
    }

    public async Task<User?> GetByPasskeyUserHandleAsync(byte[] userHandle)
    {
        var filter = Builders<User>.Filter.And(
            Builders<User>.Filter.ElemMatch(u => u.PasskeyCredentials, c => c.UserHandle == userHandle),
            Builders<User>.Filter.Eq(u => u.IsDeleted, false)
        );
        return await _context.Users.Find(filter).FirstOrDefaultAsync();
    }

    public async Task<bool> IsPasskeyCredentialIdUniqueAsync(byte[] credentialId)
    {
        var count = await _context.Users.CountDocumentsAsync(
            Builders<User>.Filter.ElemMatch(u => u.PasskeyCredentials, c => c.CredentialId == credentialId)
        );
        return count == 0;
    }

    public async Task UpsertPasskeyCredentialAsync(string userId, StoredCredential credential)
    {
        // Two-step: try update-existing (matched by credentialId), if no
        // match then push as new. Both branches are single-document atomic.
        var matchExisting = Builders<User>.Filter.And(
            Builders<User>.Filter.Eq(u => u.Id, userId),
            Builders<User>.Filter.ElemMatch(u => u.PasskeyCredentials, c => c.CredentialId == credential.CredentialId)
        );
        var updateExisting = Builders<User>.Update
            .Set("passkeyCredentials.$.signCount", credential.SignCount)
            .Set("passkeyCredentials.$.lastUsedAt", credential.LastUsedAt ?? DateTime.UtcNow);
        var result = await _context.Users.UpdateOneAsync(matchExisting, updateExisting);
        if (result.MatchedCount > 0) return;

        // Not present yet — push a new entry onto the array.
        await _context.Users.UpdateOneAsync(
            u => u.Id == userId,
            Builders<User>.Update.Push(u => u.PasskeyCredentials, credential)
        );
    }

    public async Task<bool> UpdatePasskeySignCountAsync(string userId, byte[] credentialId, uint newSignCount)
    {
        var filter = Builders<User>.Filter.And(
            Builders<User>.Filter.Eq(u => u.Id, userId),
            Builders<User>.Filter.ElemMatch(u => u.PasskeyCredentials, c => c.CredentialId == credentialId)
        );
        var update = Builders<User>.Update
            .Set("passkeyCredentials.$.signCount", newSignCount)
            .Set("passkeyCredentials.$.lastUsedAt", DateTime.UtcNow);
        var result = await _context.Users.UpdateOneAsync(filter, update);
        return result.MatchedCount > 0;
    }

    public async Task<bool> RemovePasskeyCredentialAsync(string userId, byte[] credentialId)
    {
        var update = Builders<User>.Update.PullFilter(
            u => u.PasskeyCredentials,
            c => c.CredentialId == credentialId
        );
        var result = await _context.Users.UpdateOneAsync(u => u.Id == userId, update);
        return result.ModifiedCount > 0;
    }

    public async Task<User?> GetByVerificationTokenAsync(string token)
    {
        return await _context.Users
            .Find(u => u.EmailVerificationToken == token && !u.IsDeleted)
            .FirstOrDefaultAsync();
    }

    public async Task<User?> GetByVerificationTokenLookupAsync(string tokenLookup)
    {
        return await _context.Users
            .Find(u => u.EmailVerificationTokenLookup == tokenLookup && !u.IsDeleted)
            .FirstOrDefaultAsync();
    }

    public async Task<List<User>> GetUnverifiedUsersAsync()
    {
        return await _context.Users
            .Find(u => !u.IsEmailVerified && u.EmailVerificationToken != null && !u.IsDeleted)
            .ToListAsync();
    }

    public async Task<bool> ExistsAsync(string email)
    {
        // ToLowerInvariant — see GetByEmailAsync for the tr-TR rationale.
        var normalized = email.ToLowerInvariant().Trim();
        return await _context.Users
            .Find(u => u.Email == normalized && !u.IsDeleted)
            .AnyAsync();
    }

    public async Task<bool> AnyUserExistsAsync()
    {
        return await _context.Users
            .Find(u => !u.IsDeleted)
            .AnyAsync();
    }

    public async Task<List<User>> GetAllAsync()
    {
        return await _context.Users
            .Find(_ => true)
            .ToListAsync();
    }

    public async Task<List<User>> GetInvitedByUserAsync(string inviterUserId)
    {
        return await _context.Users
            .Find(u => u.InvitedByUserId == inviterUserId)
            .ToListAsync();
    }

    public async Task<int> GetInvitationCountAsync(string userId)
    {
        return (int)await _context.Users
            .CountDocumentsAsync(u => u.InvitedByUserId == userId);
    }

    public async Task<User> CreateAsync(User user)
    {
        await _context.Users.InsertOneAsync(user);
        return user;
    }

    public async Task<User> UpdateAsync(User user)
    {
        await _context.Users.ReplaceOneAsync(u => u.Id == user.Id, user);
        return user;
    }

    public async Task<bool> DeleteAsync(string id)
    {
        var result = await _context.Users.DeleteOneAsync(u => u.Id == id);
        return result.DeletedCount > 0;
    }

    public async Task<bool> SoftDeleteAsync(string id, string deletedByUserId)
    {
        // Anonymize PII fields, set tombstone metadata. The document survives
        // so that referential graph (child users' InvitedByUserId, audit logs)
        // still resolves to a real row. Email is anonymized to a unique
        // sentinel so a) the unique-on-email index keeps working and b) the
        // original email is freed for a new registration (GDPR right-to-erasure).
        var anonymizedEmail = $"deleted-{id}@anon.local";
        var update = Builders<User>.Update
            .Set(u => u.IsDeleted, true)
            .Set(u => u.DeletedAt, DateTime.UtcNow)
            .Set(u => u.DeletedByUserId, deletedByUserId)
            .Set(u => u.Email, anonymizedEmail)
            .Set(u => u.DisplayName, "[deleted user]")
            .Set(u => u.PasswordHash, string.Empty) // Logins still fail because IsDeleted filter excludes
            .Unset(u => u.GoogleId)
            .Unset(u => u.EmailVerificationToken)
            .Unset(u => u.EmailVerificationTokenLookup)
            .Unset(u => u.EmailVerificationTokenExpiry);
        var result = await _context.Users.UpdateOneAsync(u => u.Id == id, update);
        return result.MatchedCount > 0;
    }

    public async Task<bool> TryReserveSlotAsync(string userId, int maxSlots)
    {
        // Single-document atomic: match user IFF activeLinkCount < maxSlots,
        // then $inc by 1. If no doc matched, returns null → quota exceeded.
        // This is the H7 fix: previously the service did Count(pending) +
        // Count(used), compared to max in app code, then InsertOne — three
        // separate round trips with a TOCTOU window between every pair.
        var filter = Builders<User>.Filter.And(
            Builders<User>.Filter.Eq(u => u.Id, userId),
            Builders<User>.Filter.Lt(u => u.ActiveLinkCount, maxSlots));
        var update = Builders<User>.Update.Inc(u => u.ActiveLinkCount, 1);
        var result = await _context.Users.FindOneAndUpdateAsync(filter, update);
        return result != null;
    }

    public async Task ReleaseSlotAsync(string userId)
    {
        // Clamped non-negative — protects against double-release bugs where
        // a link is released twice and would otherwise drift negative.
        var filter = Builders<User>.Filter.And(
            Builders<User>.Filter.Eq(u => u.Id, userId),
            Builders<User>.Filter.Gt(u => u.ActiveLinkCount, 0));
        var update = Builders<User>.Update.Inc(u => u.ActiveLinkCount, -1);
        await _context.Users.FindOneAndUpdateAsync(filter, update);
    }
}

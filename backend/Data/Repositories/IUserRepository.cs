using WatchTogether.Data.Entities;

namespace WatchTogether.Data.Repositories;

public interface IUserRepository
{
    Task<User?> GetByIdAsync(string id);
    Task<User?> GetByEmailAsync(string email);
    /// <summary>
    /// Fast lookup by Google subject claim. Backed by uniq_googleId index.
    /// Sparse, so returns null cheaply for users who never linked Google.
    /// </summary>
    Task<User?> GetByGoogleIdAsync(string googleId);

    /// <summary>
    /// Find the user who owns a passkey with this credentialId. Used during
    /// WebAuthn authentication to map an assertion back to a user.
    /// </summary>
    Task<User?> GetByPasskeyCredentialIdAsync(byte[] credentialId);

    /// <summary>
    /// Find the user with this userHandle (a per-user opaque blob we issue
    /// on first passkey registration and reuse for all credentials). Used
    /// for the usernameless ("discoverable credential") flow where the
    /// browser hands us back a userHandle without an email.
    /// </summary>
    Task<User?> GetByPasskeyUserHandleAsync(byte[] userHandle);

    /// <summary>
    /// Used by Fido2NetLib's IsCredentialIdUniqueToUser callback. Returns
    /// true if no user already owns this credentialId — a defensive check
    /// against the authenticator returning a recycled credentialId.
    /// </summary>
    Task<bool> IsPasskeyCredentialIdUniqueAsync(byte[] credentialId);

    /// <summary>
    /// Push a new credential into the user's PasskeyCredentials array, or
    /// update the SignCount + LastUsedAt of an existing one. Single-document
    /// atomic — no read-modify-write race against concurrent registration.
    /// </summary>
    Task UpsertPasskeyCredentialAsync(string userId, StoredCredential credential);

    /// <summary>
    /// Bump SignCount + LastUsedAt on a successful authentication. Returns
    /// true if the credential was found and updated.
    /// </summary>
    Task<bool> UpdatePasskeySignCountAsync(string userId, byte[] credentialId, uint newSignCount);

    /// <summary>
    /// Remove a passkey from a user. Returns true if a credential was
    /// actually removed (false if it didn't exist on the user's list).
    /// </summary>
    Task<bool> RemovePasskeyCredentialAsync(string userId, byte[] credentialId);
    Task<User?> GetByVerificationTokenAsync(string token);
    /// <summary>
    /// Fast O(1) lookup of a user by the SHA-256 hex of their verification token.
    /// Replaces the O(n) BCrypt scan over all unverified users.
    /// </summary>
    Task<User?> GetByVerificationTokenLookupAsync(string tokenLookup);
    Task<List<User>> GetUnverifiedUsersAsync();
    Task<bool> ExistsAsync(string email);
    Task<bool> AnyUserExistsAsync();
    Task<List<User>> GetAllAsync();
    Task<List<User>> GetInvitedByUserAsync(string inviterUserId);
    Task<int> GetInvitationCountAsync(string userId);
    Task<User> CreateAsync(User user);
    Task<User> UpdateAsync(User user);

    /// <summary>
    /// HARD delete — physical document removal. Reserved for the registration
    /// rollback path (email send failure before invitation is burned).
    /// Admin-driven removal must use <see cref="SoftDeleteAsync"/> instead.
    /// </summary>
    Task<bool> DeleteAsync(string id);

    /// <summary>
    /// Soft delete with anonymization. The document is preserved (so any
    /// child user's InvitedByUserId still points at a real row, the admin
    /// tree builder doesn't drop grandchildren) but the PII fields — email,
    /// displayName, passwordHash, verification tokens — are cleared so the
    /// original identity is unrecoverable. Email is set to a unique
    /// anonymized sentinel ("deleted-{id}@anon.local") so the unique-on-email
    /// index keeps working AND the original email is free for a new
    /// registration.
    /// </summary>
    Task<bool> SoftDeleteAsync(string id, string deletedByUserId);

    /// <summary>
    /// Atomically increment ActiveLinkCount by 1 IF the current value is less
    /// than maxSlots. Returns true if the reservation succeeded, false if
    /// quota was already at the limit. Single-document atomic via Mongo's
    /// FindOneAndUpdate — defeats the TOCTOU race where two concurrent
    /// generate-link requests both pass a non-atomic count check.
    /// </summary>
    Task<bool> TryReserveSlotAsync(string userId, int maxSlots);

    /// <summary>
    /// Atomically decrement ActiveLinkCount by 1, clamped to non-negative.
    /// Called when a link is revoked or expires (TicketReturned set).
    /// </summary>
    Task ReleaseSlotAsync(string userId);
}

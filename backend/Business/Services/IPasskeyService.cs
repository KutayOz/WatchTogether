using Fido2NetLib;
using Fido2NetLib.Objects;
using WatchTogether.Data.Entities;

namespace WatchTogether.Business.Services;

/// <summary>
/// WebAuthn / passkey orchestration. The browser-side dance is:
///
///   Registration:
///      Frontend → Begin   → server returns CredentialCreateOptions
///      Browser  → authenticator → user verifies → AuthenticatorAttestationRawResponse
///      Frontend → Finish  → server stores public key
///
///   Authentication:
///      Frontend → Begin   → server returns AssertionOptions
///      Browser  → authenticator → user verifies → AuthenticatorAssertionRawResponse
///      Frontend → Finish  → server verifies signature, returns user
///
/// Challenges are single-use, time-bound, and tied to the user (registration)
/// or the request session (authentication). We cache them in IMemoryCache;
/// finishing a flow consumes its challenge.
/// </summary>
public interface IPasskeyService
{
    /// <summary>
    /// Build the CredentialCreateOptions the frontend hands to
    /// navigator.credentials.create(). Caches the embedded challenge
    /// against the user id so FinishRegistrationAsync can verify it.
    /// </summary>
    Task<CredentialCreateOptions> BeginRegistrationAsync(string userId);

    /// <summary>
    /// Verify the attestation response from navigator.credentials.create()
    /// and persist the resulting credential under the user. Returns the
    /// label assigned to the new credential on success, null on failure.
    /// </summary>
    Task<string?> FinishRegistrationAsync(
        string userId,
        AuthenticatorAttestationRawResponse response,
        string label);

    /// <summary>
    /// Begin a WebAuthn assertion. If `email` is provided we scope the
    /// allowed credentials to that user; null/empty enables the
    /// "usernameless" flow (browser picks from its resident credentials).
    /// </summary>
    Task<AssertionOptions> BeginAuthenticationAsync(string? email);

    /// <summary>
    /// Verify an assertion response, identify the user, bump SignCount,
    /// and return the resolved user. Null if anything fails (caller maps
    /// to 401).
    /// </summary>
    Task<User?> FinishAuthenticationAsync(AuthenticatorAssertionRawResponse response);

    /// <summary>List a user's registered passkeys for the manage-credentials UI.</summary>
    IReadOnlyList<StoredCredential> GetCredentialsForUser(User user);

    /// <summary>Remove a single passkey from a user. Returns true on success.</summary>
    Task<bool> RemoveCredentialAsync(string userId, byte[] credentialId);
}

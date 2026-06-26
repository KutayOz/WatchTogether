using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Fido2NetLib;
using Fido2NetLib.Objects;
using Microsoft.Extensions.Caching.Memory;
using WatchTogether.Data.Entities;
using WatchTogether.Data.Repositories;

namespace WatchTogether.Business.Services;

/// <summary>
/// PasskeyService implementation. Threads Fido2NetLib's low-level API
/// through our user model and persists the resulting credentials.
///
/// Why a memory-cached challenge instead of stuffing it back in a cookie:
///   - The registration flow is authed (cookie-based) but the challenge
///     itself is short-lived (~2 min) and we don't want it to survive a
///     reload. IMemoryCache with an absolute expiration is the simplest
///     fit; cleared automatically and never written to disk.
///   - For the usernameless auth flow we use a random session key the
///     frontend sends back in finish-auth. Same memory cache, just keyed
///     differently.
///
/// At single-instance scale this is fine. If we ever go multi-instance,
/// swap IMemoryCache for a Redis-backed IDistributedCache without touching
/// any callers — interface is the same.
/// </summary>
public class PasskeyService : IPasskeyService
{
    private readonly IFido2 _fido2;
    private readonly IUserRepository _userRepository;
    private readonly IMemoryCache _cache;

    // 2 minutes is the WebAuthn spec's recommended max challenge lifetime.
    // Anything longer raises the risk of a stale challenge being replayed.
    private static readonly TimeSpan ChallengeTtl = TimeSpan.FromMinutes(2);

    public PasskeyService(IFido2 fido2, IUserRepository userRepository, IMemoryCache cache)
    {
        _fido2 = fido2;
        _userRepository = userRepository;
        _cache = cache;
    }

    public async Task<CredentialCreateOptions> BeginRegistrationAsync(string userId)
    {
        var user = await _userRepository.GetByIdAsync(userId)
            ?? throw new InvalidOperationException("User not found");

        // userHandle: opaque, per-user, 64-byte random blob. Generated once
        // on the user's first passkey registration and reused for every
        // subsequent credential they add. WebAuthn uses this to identify
        // the user during the discoverable-credential (usernameless) flow.
        var userHandle = EnsureUserHandle(user);

        var fido2User = new Fido2User
        {
            Id = userHandle,
            Name = user.Email,
            DisplayName = user.DisplayName,
        };

        // excludeCredentials: stops the authenticator from re-registering
        // a credential it already has on file. Otherwise the user could end
        // up with two entries pointing at the same key.
        var existing = user.PasskeyCredentials
            .Select(c => new PublicKeyCredentialDescriptor(c.CredentialId))
            .ToList();

        var authenticatorSelection = new AuthenticatorSelection
        {
            // Allow any authenticator type (platform = Touch ID/Windows Hello,
            // cross-platform = security keys). Limiting to "platform" would
            // exclude YubiKeys.
            AuthenticatorAttachment = null,
            // Resident key requested but not required — the usernameless
            // flow benefits when supported (most modern authenticators do),
            // but older keys still work.
            RequireResidentKey = false,
            UserVerification = UserVerificationRequirement.Preferred,
        };

        var extensions = new AuthenticationExtensionsClientInputs();

        var options = _fido2.RequestNewCredential(
            fido2User,
            existing,
            authenticatorSelection,
            AttestationConveyancePreference.None,
            extensions);

        // Cache the options so FinishRegistration can verify the challenge.
        // Keyed by user id — only one registration in flight per user.
        _cache.Set(RegistrationCacheKey(userId), options, ChallengeTtl);

        return options;
    }

    public async Task<string?> FinishRegistrationAsync(
        string userId,
        AuthenticatorAttestationRawResponse response,
        string label)
    {
        if (!_cache.TryGetValue(RegistrationCacheKey(userId), out CredentialCreateOptions? options) || options is null)
        {
            return null; // challenge expired or never issued
        }
        _cache.Remove(RegistrationCacheKey(userId));

        // IsCredentialIdUniqueToUser is a Fido2NetLib callback — it asks
        // "has anyone else registered this credentialId?" Defensive: the
        // authenticator shouldn't reuse IDs, but we don't trust it.
        IsCredentialIdUniqueToUserAsyncDelegate uniqueCheck = async (args, _) =>
            await _userRepository.IsPasskeyCredentialIdUniqueAsync(args.CredentialId);

        Fido2.CredentialMakeResult result;
        try
        {
            result = await _fido2.MakeNewCredentialAsync(response, options, uniqueCheck);
        }
        catch (Fido2VerificationException)
        {
            return null;
        }

        if (result.Status != "ok" || result.Result is null) return null;

        var user = await _userRepository.GetByIdAsync(userId);
        if (user is null) return null;

        var credential = new StoredCredential
        {
            CredentialId = result.Result.CredentialId,
            PublicKey = result.Result.PublicKey,
            SignCount = result.Result.Counter,
            AaGuid = result.Result.Aaguid,
            UserHandle = EnsureUserHandle(user),
            Label = string.IsNullOrWhiteSpace(label)
                ? $"Passkey added {DateTime.UtcNow:yyyy-MM-dd}"
                : label.Trim(),
            RegisteredAt = DateTime.UtcNow,
        };

        await _userRepository.UpsertPasskeyCredentialAsync(userId, credential);
        return credential.Label;
    }

    public async Task<AssertionOptions> BeginAuthenticationAsync(string? email)
    {
        var allowedCredentials = new List<PublicKeyCredentialDescriptor>();
        if (!string.IsNullOrWhiteSpace(email))
        {
            var user = await _userRepository.GetByEmailAsync(email);
            if (user is not null)
            {
                allowedCredentials.AddRange(
                    user.PasskeyCredentials.Select(c => new PublicKeyCredentialDescriptor(c.CredentialId))
                );
            }
            // If user not found, we deliberately still build options with an
            // empty allowedCredentials list — the response time matches the
            // user-exists case, so we don't leak email enumeration via timing.
        }

        var options = _fido2.GetAssertionOptions(
            allowedCredentials,
            UserVerificationRequirement.Preferred);

        // Cache by challenge hash since we don't have a user id yet (the
        // usernameless flow doesn't know who's signing in until the
        // browser hands the assertion back).
        var key = AuthCacheKey(options.Challenge);
        _cache.Set(key, options, ChallengeTtl);

        return options;
    }

    public async Task<User?> FinishAuthenticationAsync(AuthenticatorAssertionRawResponse response)
    {
        // Recover the options we issued. The frontend echoes the challenge
        // back inside response.Response.ClientDataJson, so we extract it
        // and look up the cached options.
        var clientDataJson = JsonSerializer.Deserialize<JsonElement>(response.Response.ClientDataJson);
        if (!clientDataJson.TryGetProperty("challenge", out var challengeProp)) return null;
        var challengeB64 = challengeProp.GetString();
        if (string.IsNullOrEmpty(challengeB64)) return null;
        var challenge = Base64Url.Decode(challengeB64);

        var cacheKey = AuthCacheKey(challenge);
        if (!_cache.TryGetValue(cacheKey, out AssertionOptions? options) || options is null)
        {
            return null;
        }
        _cache.Remove(cacheKey);

        // Find the user. WebAuthn assertions include the credentialId in
        // response.Id (always) and a userHandle in response.Response.UserHandle
        // (only for resident-key / usernameless flows).
        var user = await _userRepository.GetByPasskeyCredentialIdAsync(response.Id);
        if (user is null && response.Response.UserHandle is { Length: > 0 } handle)
        {
            user = await _userRepository.GetByPasskeyUserHandleAsync(handle);
        }
        if (user is null) return null;

        var credential = user.PasskeyCredentials.FirstOrDefault(c => c.CredentialId.SequenceEqual(response.Id));
        if (credential is null) return null;

        IsUserHandleOwnerOfCredentialIdAsync userHandleCheck = async (args, _) =>
        {
            var ownerByHandle = await _userRepository.GetByPasskeyUserHandleAsync(args.UserHandle);
            return ownerByHandle?.Id == user.Id;
        };

        AssertionVerificationResult verifyResult;
        try
        {
            verifyResult = await _fido2.MakeAssertionAsync(
                response,
                options,
                credential.PublicKey,
                credential.SignCount,
                userHandleCheck);
        }
        catch (Fido2VerificationException)
        {
            return null;
        }

        if (verifyResult.Status != "ok") return null;

        // Persist the new SignCount + LastUsedAt — drops a clone-detection
        // anchor for next time.
        await _userRepository.UpdatePasskeySignCountAsync(user.Id, response.Id, verifyResult.Counter);

        return user;
    }

    public IReadOnlyList<StoredCredential> GetCredentialsForUser(User user) =>
        user.PasskeyCredentials.AsReadOnly();

    public Task<bool> RemoveCredentialAsync(string userId, byte[] credentialId) =>
        _userRepository.RemovePasskeyCredentialAsync(userId, credentialId);

    /* ─────────────────── helpers ─────────────────── */

    private static string RegistrationCacheKey(string userId) => $"webauthn:reg:{userId}";
    private static string AuthCacheKey(byte[] challenge) =>
        $"webauthn:auth:{Convert.ToHexString(SHA256.HashData(challenge))}";

    /// <summary>
    /// Make sure the user has a stable userHandle. If they already have at
    /// least one passkey, reuse the existing one — otherwise generate a
    /// fresh 64-byte random blob. (We don't persist this separately; it
    /// lives inside each StoredCredential's UserHandle field. On a fresh
    /// registration we synthesize one, on subsequent ones we copy from
    /// any existing credential.)
    /// </summary>
    private static byte[] EnsureUserHandle(User user)
    {
        var existing = user.PasskeyCredentials.FirstOrDefault();
        if (existing?.UserHandle is { Length: > 0 }) return existing.UserHandle;
        return RandomNumberGenerator.GetBytes(64);
    }
}

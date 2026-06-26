using MongoDB.Bson.Serialization.Attributes;

namespace WatchTogether.Data.Entities;

/// <summary>
/// One WebAuthn credential (passkey) registered to a user. Stored embedded
/// inside <see cref="User.PasskeyCredentials"/> rather than as its own
/// collection — a user typically has 1-5 of these, query patterns are
/// always "load the user," and we never need credential-by-credential
/// indexing outside the per-user list.
///
/// The actual cryptographic material here is the public-key blob. Private
/// keys live on the user's authenticator (Touch ID secure enclave, YubiKey,
/// etc.) and never leave it — that's the whole point of WebAuthn. Compromise
/// of this collection cannot impersonate the user.
/// </summary>
public class StoredCredential
{
    /// <summary>
    /// The credential's unique ID (issued by the authenticator at registration).
    /// We look this up during authentication to find which user is signing in
    /// + which public key to verify against. Indexed-as-bytes inside Mongo.
    /// </summary>
    [BsonElement("credentialId")]
    public byte[] CredentialId { get; set; } = null!;

    /// <summary>
    /// COSE-encoded public key blob. Fido2NetLib parses this back into the
    /// curve/key it needs at verify time.
    /// </summary>
    [BsonElement("publicKey")]
    public byte[] PublicKey { get; set; } = null!;

    /// <summary>
    /// Monotonic counter the authenticator increments on every assertion.
    /// We track the last value we saw — a regression means cloning. The
    /// Fido2NetLib library checks this for us; we just persist the new
    /// value after a successful authentication.
    /// </summary>
    [BsonElement("signCount")]
    public uint SignCount { get; set; }

    /// <summary>
    /// Authenticator model identifier (manufacturer + model). Useful for
    /// surfacing a friendly device type in the UI ("YubiKey 5C") and for
    /// future attestation policy.
    /// </summary>
    [BsonElement("aaGuid")]
    public Guid AaGuid { get; set; }

    /// <summary>
    /// Random per-user opaque blob WebAuthn uses to map a credential back to
    /// a user during usernameless ("discoverable credential") flows. Same
    /// userHandle for every credential a user registers; the UserRepository
    /// generates one on the user's first passkey registration and reuses it.
    /// </summary>
    [BsonElement("userHandle")]
    public byte[] UserHandle { get; set; } = null!;

    /// <summary>
    /// Human-friendly label the user picked when registering (or we
    /// auto-generated, e.g. "Passkey added on 2026-05-26"). Shown on the
    /// "manage passkeys" page so they know which physical key to remove.
    /// </summary>
    [BsonElement("label")]
    public string Label { get; set; } = null!;

    [BsonElement("registeredAt")]
    public DateTime RegisteredAt { get; set; } = DateTime.UtcNow;

    [BsonElement("lastUsedAt")]
    public DateTime? LastUsedAt { get; set; }
}

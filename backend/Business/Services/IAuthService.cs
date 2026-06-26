using WatchTogether.Business.DTOs;

namespace WatchTogether.Business.Services;

public interface IAuthService
{
    // Login
    Task<ExtendedLoginResponse?> LoginAsync(string email, string password);

    /// <summary>
    /// Sign in / sign up with a Google ID token (from Google Identity Services
    /// on the frontend). Resolves the user by GoogleId → email → (if a valid
    /// invitation link was attached) new account.
    ///
    /// invitation-gated for new accounts: a fresh Google identity that has
    /// never been seen before — no GoogleId match, no email match — must
    /// carry a valid invitationLinkToken or the call is rejected. Open
    /// registration is OFF. Existing accounts (returning Google users or
    /// local accounts being linked) ignore the token entirely.
    ///
    /// Returns null when the token is invalid, the audience mismatches
    /// Google:ClientId config, the Google account email isn't verified, or
    /// the new-user path was hit with a missing/invalid invitation link.
    /// </summary>
    Task<ExtendedLoginResponse?> GoogleSignInAsync(string idToken, string? invitationLinkToken = null);

    /// <summary>
    /// Build the standard authenticated-user response (JWT + display info +
    /// slot state) for an already-resolved user. Used by sign-in flows that
    /// authenticate the user themselves (passkey, etc.) and just need the
    /// final response shape and cookie payload.
    /// </summary>
    Task<ExtendedLoginResponse> IssueLoginResponseAsync(WatchTogether.Data.Entities.User user);

    // Current user (used by frontend to refresh cached state after side-effecting actions)
    Task<MeResponse?> GetCurrentUserAsync(string userId);

    // Registration (legacy email-based invitation)
    Task<ValidateInvitationResponse> ValidateInvitationTokenAsync(string token);
    Task<(bool Success, string Message, string? Email)> RegisterAsync(string invitationToken, string displayName, string password);

    // Registration (new link-based invitation - no email required from inviter)
    Task<(bool Success, string Message, string? Email)> RegisterWithLinkAsync(
        string linkToken, string email, string displayName, string password);

    // Email verification (magic link)
    Task<(bool Success, string Message)> VerifyEmailByTokenAsync(string token);
    Task<(bool Success, string Message)> ResendVerificationEmailAsync(string email);

    // Terms
    Task<(bool Success, string Message)> AcceptTermsAsync(string userId, string version);

    // First-run setup
    /// <summary>
    /// Returns true once any user exists in the database. Used by the setup
    /// flow to decide whether the create-root endpoint is open or sealed.
    /// </summary>
    Task<bool> IsSetupCompleteAsync();

    /// <summary>
    /// One-shot bootstrap to create the very first user as a root admin.
    ///
    /// Strict invariant: this is rejected with Success=false if ANY user
    /// already exists (active OR soft-deleted). The check is also enforced
    /// at the storage layer by the unique-on-email index, so even a TOCTOU
    /// race can't get two roots created.
    ///
    /// The created user is email-verified up-front (no magic-link round
    /// trip — the very first user has nobody to verify them anyway) and
    /// IsRootUser=true. Returns the standard ExtendedLoginResponse so the
    /// caller can immediately set the auth cookie.
    /// </summary>
    Task<(bool Success, string Message, ExtendedLoginResponse? Response)>
        CreateRootUserAsync(string email, string displayName, string password);
}

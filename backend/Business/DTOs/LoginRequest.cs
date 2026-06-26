namespace WatchTogether.Business.DTOs;

public class LoginRequest
{
    public string Email { get; set; } = null!;
    public string Password { get; set; } = null!;
    /// <summary>
    /// When true, the auth cookie is persistent (Max-Age = JWT lifetime).
    /// When false, it's a session cookie that dies when the browser closes.
    /// </summary>
    public bool RememberMe { get; set; }
}

/// <summary>
/// Body for POST /api/auth/google. The frontend ships the raw ID token
/// it obtained from Google Identity Services; everything else (audience
/// validation, signature check, user resolution) happens server-side.
/// </summary>
public class GoogleSignInRequest
{
    public string IdToken { get; set; } = null!;

    /// <summary>
    /// Optional — only present when this Google sign-in is the FIRST sign-in
    /// for a brand-new user that arrived through an invitation link. The
    /// backend treats Google sign-in as invitation-gated for new accounts:
    /// existing accounts (matched by GoogleId or email) ignore this field.
    /// </summary>
    public string? InvitationLinkToken { get; set; }
}

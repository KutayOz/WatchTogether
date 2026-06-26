using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Fido2NetLib;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using WatchTogether.Business.Services;

namespace WatchTogether.API.Controllers;

/// <summary>
/// WebAuthn passkey endpoints. Split into two groups:
///
///   /register/begin + /register/finish (authed)
///     A logged-in user adds a new passkey to their account. Bound to the
///     cookie's user id — you can only attach passkeys to YOUR account.
///
///   /auth/begin + /auth/finish (public)
///     A visitor signs in via passkey. /auth/begin returns the challenge,
///     the browser collects an assertion, /auth/finish verifies + sets the
///     JWT cookie. Same response shape as the password-login endpoint.
///
///   /list + /remove (authed)
///     Manage the user's registered passkeys.
/// </summary>
[ApiController]
[Route("api/auth/passkey")]
public class PasskeyController : ControllerBase
{
    private readonly IPasskeyService _passkeyService;
    private readonly IAuthService _authService;

    // Cookie config MUST stay in sync with AuthController — same name AND same
    // BuildAuthCookieOptions policy (Path/SameSite/Secure). The browser only
    // overwrites/deletes a cookie when these attributes match, and a SameSite
    // mismatch silently weakens CSRF protection on whichever writer is laxer.
    private const string AuthCookieName = "wt_auth";

    public PasskeyController(IPasskeyService passkeyService, IAuthService authService)
    {
        _passkeyService = passkeyService;
        _authService = authService;
    }

    /* ────────────────── Registration (authed) ────────────────── */

    [HttpPost("register/begin")]
    [Authorize]
    public async Task<IActionResult> RegisterBegin()
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (string.IsNullOrEmpty(userId)) return Unauthorized();

        var options = await _passkeyService.BeginRegistrationAsync(userId);
        return Ok(options);
    }

    public class FinishRegistrationRequest
    {
        public AuthenticatorAttestationRawResponse Response { get; set; } = null!;
        /// <summary>Friendly label for the new passkey — shown in the manage UI.</summary>
        public string Label { get; set; } = string.Empty;
    }

    [HttpPost("register/finish")]
    [Authorize]
    public async Task<IActionResult> RegisterFinish([FromBody] FinishRegistrationRequest request)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (string.IsNullOrEmpty(userId)) return Unauthorized();

        var label = await _passkeyService.FinishRegistrationAsync(userId, request.Response, request.Label);
        if (label is null) return BadRequest(new { message = "Passkey registration failed" });

        return Ok(new { label });
    }

    /* ────────────────── Authentication (public) ────────────────── */

    public class BeginAuthRequest
    {
        /// <summary>Optional. If provided, scopes allowed credentials to this email's user.</summary>
        public string? Email { get; set; }
    }

    [HttpPost("auth/begin")]
    [EnableRateLimiting("auth")]
    public async Task<IActionResult> AuthBegin([FromBody] BeginAuthRequest request)
    {
        var options = await _passkeyService.BeginAuthenticationAsync(request.Email);
        return Ok(options);
    }

    [HttpPost("auth/finish")]
    [EnableRateLimiting("auth")]
    public async Task<IActionResult> AuthFinish([FromBody] AuthenticatorAssertionRawResponse response)
    {
        var user = await _passkeyService.FinishAuthenticationAsync(response);
        if (user is null)
        {
            return Unauthorized(new { message = "Passkey authentication failed" });
        }

        var loginResponse = await _authService.IssueLoginResponseAsync(user);
        Response.Cookies.Append(AuthCookieName, loginResponse.Token, BuildAuthCookieOptions(rememberMe: true));
        loginResponse.Token = string.Empty;
        return Ok(loginResponse);
    }

    /* ────────────────── Manage (authed) ────────────────── */

    public class PasskeyListItem
    {
        public string CredentialIdBase64Url { get; set; } = null!;
        public string Label { get; set; } = null!;
        public Guid AaGuid { get; set; }
        public DateTime RegisteredAt { get; set; }
        public DateTime? LastUsedAt { get; set; }
    }

    /// <summary>List the calling user's passkeys.</summary>
    [HttpGet("")]
    [Authorize]
    public async Task<IActionResult> ListCredentials([FromServices] Data.Repositories.IUserRepository userRepo)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (string.IsNullOrEmpty(userId)) return Unauthorized();

        var user = await userRepo.GetByIdAsync(userId);
        if (user is null) return Unauthorized();

        var items = user.PasskeyCredentials.Select(c => new PasskeyListItem
        {
            CredentialIdBase64Url = Base64Url.Encode(c.CredentialId),
            Label = c.Label,
            AaGuid = c.AaGuid,
            RegisteredAt = c.RegisteredAt,
            LastUsedAt = c.LastUsedAt,
        }).ToList();

        return Ok(new { items });
    }

    [HttpDelete("{credentialIdBase64Url}")]
    [Authorize]
    public async Task<IActionResult> Remove(string credentialIdBase64Url)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (string.IsNullOrEmpty(userId)) return Unauthorized();

        byte[] credentialId;
        try { credentialId = Base64Url.Decode(credentialIdBase64Url); }
        catch { return BadRequest(new { message = "Invalid credential id" }); }

        var removed = await _passkeyService.RemoveCredentialAsync(userId, credentialId);
        if (!removed) return NotFound(new { message = "Passkey not found" });
        return NoContent();
    }

    /* ────────────────── cookie helpers ────────────────── */

    private CookieOptions BuildAuthCookieOptions(bool rememberMe)
    {
        return new CookieOptions
        {
            HttpOnly = true,
            Secure = Request.IsHttps,        // HTTPS-only in prod; auto-relaxes in local HTTP dev — matches AuthController
            SameSite = SameSiteMode.Strict,  // Same cookie as AuthController writes; Strict on both or CSRF posture drifts
            Path = "/",
            Expires = rememberMe ? DateTimeOffset.UtcNow.AddDays(7) : null,
        };
    }
}

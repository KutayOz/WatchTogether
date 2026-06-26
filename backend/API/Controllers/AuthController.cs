using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Configuration;
using WatchTogether.Business.DTOs;
using WatchTogether.Business.Services;
using WatchTogether.Data.Entities;
using WatchTogether.Data.Repositories;

namespace WatchTogether.API.Controllers;

[ApiController]
[Route("api/[controller]")]
public class AuthController : ControllerBase
{
    private readonly IAuthService _authService;
    private readonly IConfiguration _configuration;
    private readonly IRevokedTokenRepository _revokedTokenRepository;

    /// <summary>
    /// Name of the HttpOnly auth cookie. Short prefix so it's unambiguous in
    /// devtools and doesn't collide with any other app cookie under the same
    /// registrable domain.
    /// </summary>
    private const string AuthCookieName = "wt_auth";

    public AuthController(
        IAuthService authService,
        IConfiguration configuration,
        IRevokedTokenRepository revokedTokenRepository)
    {
        _authService = authService;
        _configuration = configuration;
        _revokedTokenRepository = revokedTokenRepository;
    }

    /// <summary>
    /// Build the cookie options used for both setting (login) and clearing (logout)
    /// the auth cookie. Both must match in Path/SameSite/Secure or the browser
    /// refuses to overwrite/delete the cookie.
    /// </summary>
    private CookieOptions BuildAuthCookieOptions(bool rememberMe)
    {
        var expirationHours = int.TryParse(_configuration["Jwt:ExpirationHours"], out var parsedExpiration) ? parsedExpiration : 24;
        return new CookieOptions
        {
            HttpOnly = true,                      // JS can't read it — XSS won't leak the token
            Secure = Request.IsHttps,             // HTTPS-only in prod; auto-relaxes in local HTTP dev
            SameSite = SameSiteMode.Strict,       // Browser blocks cross-site sends → CSRF mitigated
            Path = "/",                           // Sent to all endpoints (REST + SignalR hub)
            // Persistent if rememberMe, otherwise session cookie (no Expires/Max-Age → dies on browser close)
            Expires = rememberMe ? DateTime.UtcNow.AddHours(expirationHours) : null,
        };
    }

    [HttpGet("me")]
    [Authorize]
    public async Task<IActionResult> Me()
    {
        var userId = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (userId == null) return Unauthorized();

        var me = await _authService.GetCurrentUserAsync(userId);
        if (me == null) return NotFound(new { message = "User not found" });

        return Ok(me);
    }

    [HttpPost("login")]
    [EnableRateLimiting("auth-login")]
    public async Task<IActionResult> Login([FromBody] LoginRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Email))
            return BadRequest(new { message = "Email is required" });

        if (string.IsNullOrWhiteSpace(request.Password))
            return BadRequest(new { message = "Password is required" });

        var response = await _authService.LoginAsync(request.Email, request.Password);
        if (response == null)
            return Unauthorized(new { message = "Invalid email or password" });

        // Drop the JWT into an HttpOnly cookie. The client never sees it from JS —
        // XSS can no longer exfiltrate the token. The cookie is sent automatically
        // on subsequent requests as long as the frontend uses credentials:'include'.
        Response.Cookies.Append(AuthCookieName, response.Token, BuildAuthCookieOptions(request.RememberMe));

        // Strip the token from the response body — clients shouldn't read it any more.
        // (Field still exists on the DTO to avoid a coordinated server+client API rev;
        //  it's effectively dead-code on the client.)
        response.Token = string.Empty;

        return Ok(response);
    }

    /// <summary>
    /// Google Sign-In endpoint. The frontend exchanges the user's Google
    /// credential for an ID token using Google Identity Services (one-tap
    /// or popup), then POSTs that token here. We validate it against
    /// Google's JWKS + our configured Audience (Google:ClientId), then
    /// resolve / create the user via AuthService.GoogleSignInAsync and
    /// drop the same HttpOnly auth cookie as the password-login path.
    ///
    /// Rate-limited under the same "auth" bucket as login to prevent a
    /// flood of token-validation requests from exhausting CPU.
    /// </summary>
    [HttpPost("google")]
    [EnableRateLimiting("auth")]
    public async Task<IActionResult> Google([FromBody] GoogleSignInRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.IdToken))
            return BadRequest(new { message = "Token is required" });

        var response = await _authService.GoogleSignInAsync(request.IdToken, request.InvitationLinkToken);
        if (response == null)
            return Unauthorized(new { message = "Google sign-in failed" });

        // Google sign-in defaults to "remember me" — the user explicitly chose
        // Google, they want to stay signed in. Matches Gmail / Drive defaults.
        Response.Cookies.Append(AuthCookieName, response.Token, BuildAuthCookieOptions(rememberMe: true));
        response.Token = string.Empty;
        return Ok(response);
    }

    /// <summary>
    /// Clear the auth cookie AND add the JTI to the revocation deny-list, so a
    /// captured cookie can't be replayed elsewhere even before its `exp`.
    /// Idempotent — RevokeAsync swallows duplicate-key on a concurrent logout.
    /// </summary>
    [HttpPost("logout")]
    [Authorize]
    public async Task<IActionResult> Logout()
    {
        // Add to the deny-list FIRST. Order matters: if a clear-then-revoke crash
        // happens between steps, the user is "logged out in browser but token
        // still valid" — exactly the gap this fix is meant to close. The
        // clear-cookie step is cheap and always succeeds, so do it second.
        var jti = User.FindFirst(JwtRegisteredClaimNames.Jti)?.Value;
        var expClaim = User.FindFirst(JwtRegisteredClaimNames.Exp)?.Value;
        var userId = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (!string.IsNullOrEmpty(jti) && long.TryParse(expClaim, out var expUnix))
        {
            await _revokedTokenRepository.RevokeAsync(new RevokedToken
            {
                Jti = jti,
                ExpiresAt = DateTimeOffset.FromUnixTimeSeconds(expUnix).UtcDateTime,
                UserId = userId,
            });
        }

        Response.Cookies.Delete(AuthCookieName, BuildAuthCookieOptions(rememberMe: false));
        return Ok(new { message = "Logged out" });
    }

    [HttpGet("invitation/{token}")]
    [EnableRateLimiting("invitation")]
    public async Task<IActionResult> ValidateInvitation(string token)
    {
        var response = await _authService.ValidateInvitationTokenAsync(token);
        return Ok(response);
    }

    /// <summary>
    /// First-run setup status. Frontend (or curl during cold-start ops) calls
    /// this to decide whether to surface the create-root flow or the regular
    /// login screen. Returns IsSetupComplete=true the moment any user exists.
    ///
    /// Intentionally anonymous + no rate limit beyond the broad auth bucket —
    /// the endpoint leaks one bit (does the deployment have any users?) which
    /// is operationally useful, not sensitive.
    /// </summary>
    [HttpGet("setup/status")]
    [EnableRateLimiting("auth")]
    public async Task<IActionResult> SetupStatus()
    {
        var isComplete = await _authService.IsSetupCompleteAsync();
        return Ok(new SetupStatusResponse { IsSetupComplete = isComplete });
    }

    /// <summary>
    /// One-shot endpoint to create the very first user as a root admin.
    ///
    /// Refuses with 403 once any user exists in the DB — so this is safe to
    /// leave hot-wired in production. The same response shape as /login is
    /// returned and the auth cookie is set, so the caller is signed in
    /// immediately after creation.
    ///
    /// Goes through the auth-register rate-limit bucket — even though the
    /// endpoint is gated by AnyUserExists, the bucket keeps a misconfigured
    /// or freshly-wiped deployment from being a brute-force playground for
    /// the 30-second window before the first root lands.
    /// </summary>
    [HttpPost("setup/create-root")]
    [EnableRateLimiting("auth-register")]
    public async Task<IActionResult> CreateRoot([FromBody] CreateRootUserRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Email))
            return BadRequest(new { message = "Email is required" });
        if (string.IsNullOrWhiteSpace(request.DisplayName))
            return BadRequest(new { message = "Display name is required" });
        if (string.IsNullOrWhiteSpace(request.Password))
            return BadRequest(new { message = "Password is required" });

        var (success, message, response) = await _authService.CreateRootUserAsync(
            request.Email, request.DisplayName, request.Password);

        if (!success || response == null)
        {
            // Once setup is complete the same endpoint must be inert. 403 is
            // semantically right here ("authenticated or not, this resource
            // is closed") and distinguishes from 400 (your input was bad) or
            // 401 (you need to sign in — which is exactly NOT the answer
            // here). Anything other than the AnyUserExists guard returns 400.
            if (message.Contains("Setup is already complete"))
                return StatusCode(StatusCodes.Status403Forbidden, new { message });
            return BadRequest(new { message });
        }

        // Same cookie path the regular login uses. RememberMe=true on setup
        // is the sensible default — you don't want to re-bootstrap on every
        // browser restart.
        Response.Cookies.Append(AuthCookieName, response.Token, BuildAuthCookieOptions(rememberMe: true));
        response.Token = string.Empty;

        return Ok(response);
    }

    /// <summary>
    /// Register using legacy email-based invitation (inviter specified invitee email)
    /// </summary>
    [HttpPost("register")]
    [EnableRateLimiting("auth-register")]
    public async Task<IActionResult> Register([FromBody] RegisterRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.InvitationToken))
            return BadRequest(new { message = "Invitation token is required" });

        if (string.IsNullOrWhiteSpace(request.DisplayName))
            return BadRequest(new { message = "Display name is required" });

        if (string.IsNullOrWhiteSpace(request.Password))
            return BadRequest(new { message = "Password is required" });

        var (success, message, email) = await _authService.RegisterAsync(
            request.InvitationToken,
            request.DisplayName,
            request.Password);

        if (!success)
            return BadRequest(new { message });

        return Ok(new RegisterResponse
        {
            Email = email!,
            Message = message
        });
    }

    /// <summary>
    /// Register using new link-based invitation (user provides their own email)
    /// </summary>
    [HttpPost("register-with-link")]
    [EnableRateLimiting("auth-register")]
    public async Task<IActionResult> RegisterWithLink([FromBody] RegisterWithLinkRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.LinkToken))
            return BadRequest(new { message = "Invitation link token is required" });

        if (string.IsNullOrWhiteSpace(request.Email))
            return BadRequest(new { message = "Email is required" });

        if (string.IsNullOrWhiteSpace(request.DisplayName))
            return BadRequest(new { message = "Display name is required" });

        if (string.IsNullOrWhiteSpace(request.Password))
            return BadRequest(new { message = "Password is required" });

        var (success, message, email) = await _authService.RegisterWithLinkAsync(
            request.LinkToken,
            request.Email,
            request.DisplayName,
            request.Password);

        if (!success)
            return BadRequest(new { message });

        return Ok(new RegisterResponse
        {
            Email = email!,
            Message = message
        });
    }

    /// <summary>
    /// Verify email using magic link token
    /// </summary>
    [HttpGet("verify-email/{token}")]
    [EnableRateLimiting("auth-verify")]
    public async Task<IActionResult> VerifyEmailByToken(string token)
    {
        if (string.IsNullOrWhiteSpace(token))
            return BadRequest(new { message = "Verification token is required" });

        var (success, message) = await _authService.VerifyEmailByTokenAsync(token);

        return Ok(new VerifyEmailResponse
        {
            Success = success,
            Message = message
        });
    }

    [HttpPost("resend-verification")]
    [EnableRateLimiting("auth-resend")]
    public async Task<IActionResult> ResendVerification([FromBody] ResendVerificationRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Email))
            return BadRequest(new { message = "Email is required" });

        var (success, message) = await _authService.ResendVerificationEmailAsync(request.Email);

        if (!success)
            return BadRequest(new { message });

        return Ok(new { message });
    }
}

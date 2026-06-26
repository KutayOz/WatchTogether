using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using WatchTogether.Business.DTOs;
using WatchTogether.Business.Services;

namespace WatchTogether.API.Controllers;

[ApiController]
[Route("api/[controller]")]
[Authorize]
public class SessionController : ControllerBase
{
    private readonly ISessionService _sessionService;
    private readonly IConfiguration _configuration;

    public SessionController(ISessionService sessionService, IConfiguration configuration)
    {
        _sessionService = sessionService;
        _configuration = configuration;
    }

    [HttpPost("create")]
    public IActionResult CreateSession()
    {
        var userId = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (userId == null)
            return Unauthorized();

        var sessionId = _sessionService.CreateSession(userId);
        return Ok(new CreateSessionResponse { SessionId = sessionId });
    }

    [HttpGet("{id}/validate")]
    [EnableRateLimiting("session")]
    public IActionResult ValidateSession(string id)
    {
        var exists = _sessionService.SessionExists(id);
        var count = _sessionService.GetParticipantCount(id);
        return Ok(new ValidateSessionResponse
        {
            Exists = exists,
            Valid = exists && count < 2,
            ParticipantCount = count
        });
    }

    [HttpGet("ice-servers")]
    [EnableRateLimiting("session")]
    public async Task<IActionResult> GetIceServers()
    {
        // Pass the caller's userId so SessionService can mint per-user credentials.
        // Preferred path is Cloudflare Realtime TURN (async HTTP mint); falls back
        // to coturn time-bound or static credentials transparently.
        var userId = User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value ?? "anonymous";
        var config = await _sessionService.GetIceServersAsync(userId);
        return Ok(config);
    }

    /// <summary>
    /// Generate a one-time invite link for a session
    /// </summary>
    [HttpPost("{id}/invite")]
    public IActionResult GenerateInvite(string id)
    {
        var userId = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (userId == null)
            return Unauthorized();

        var session = _sessionService.GetSession(id);
        if (session == null)
            return NotFound(new { message = "Session does not exist" });
        if (session.CreatorUserId != userId)
            return Forbid();

        var frontendUrl = _configuration["App:FrontendUrl"] ?? "http://localhost:5173";
        var result = _sessionService.GenerateInvite(id, userId, frontendUrl);

        if (!result.Success)
            return BadRequest(new { message = result.Message });

        return Ok(new SessionInviteResponse
        {
            Success = true,
            InviteUrl = result.InviteUrl,
            ExpiresAt = result.ExpiresAt
        });
    }

    /// <summary>
    /// Validate a session invite token (called when peer clicks invite link)
    /// </summary>
    [HttpGet("invite/{token}/validate")]
    [EnableRateLimiting("invitation")]
    public IActionResult ValidateInvite(string token)
    {
        var result = _sessionService.ValidateInvite(token);

        return Ok(new ValidateSessionInviteResponse
        {
            Valid = result.Valid,
            Message = result.Message,
            SessionId = result.SessionId,
            CreatorDisplayName = result.CreatorDisplayName
        });
    }

    /// <summary>
    /// Join a session using an invite token
    /// </summary>
    [HttpPost("invite/{token}/join")]
    public IActionResult JoinWithInvite(string token)
    {
        var userId = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (userId == null)
            return Unauthorized();

        var result = _sessionService.ValidateInvite(token);
        if (!result.Valid)
            return BadRequest(new { message = result.Message });

        // Atomic single-use guard: only the caller who wins the
        // Interlocked.CompareExchange race actually joins. If we lost the race
        // (another tab / another request was a hair faster), surface as a
        // friendly "already used" error rather than a 200 that misleads the
        // user into thinking they joined when they didn't.
        if (!_sessionService.MarkInviteUsed(token, userId))
        {
            return BadRequest(new { message = "This invite has already been used." });
        }

        return Ok(new JoinWithInviteResponse
        {
            Success = true,
            SessionId = result.SessionId
        });
    }
}

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using WatchTogether.Business.Services;

namespace WatchTogether.API.Controllers;

[ApiController]
[Route("api/demo-requests")]
[AllowAnonymous]
public class DemoRequestController : ControllerBase
{
    private readonly IDemoRequestService _demoRequestService;

    public DemoRequestController(IDemoRequestService demoRequestService)
    {
        _demoRequestService = demoRequestService;
    }

    /// <summary>
    /// Anonymous endpoint. Tight rate limit (3 per 5 min per IP) so a
    /// drive-by submitter can't flood the admin mailbox.
    /// </summary>
    [HttpPost]
    [EnableRateLimiting("demo-request")]
    public async Task<IActionResult> Submit([FromBody] SubmitDemoRequestDto dto)
    {
        if (dto == null)
        {
            return BadRequest(new { message = "Request body is required." });
        }

        // ForwardedHeaders middleware has already rewritten this to the real
        // client IP (not the edge proxy), so it's safe to persist for forensics.
        var clientIp = HttpContext.Connection.RemoteIpAddress?.ToString();

        var result = await _demoRequestService.SubmitAsync(
            dto.Email,
            dto.DisplayName,
            dto.Message,
            clientIp);

        if (!result.Success)
        {
            return BadRequest(new { message = result.Message });
        }

        return Ok(new { message = result.Message });
    }
}

public class SubmitDemoRequestDto
{
    public string Email { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string? Message { get; set; }
}

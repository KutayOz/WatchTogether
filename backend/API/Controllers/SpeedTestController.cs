using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using WatchTogether.Business.Services;

namespace WatchTogether.API.Controllers;

[ApiController]
[Route("api/[controller]")]
[Authorize]
public class SpeedTestController : ControllerBase
{
    private readonly ISpeedTestService _speedTestService;

    public SpeedTestController(ISpeedTestService speedTestService)
    {
        _speedTestService = speedTestService;
    }

    [HttpPost("upload")]
    [RequestSizeLimit(512 * 1024)] // 512KB max (binary payload)
    public async Task<IActionResult> TestUpload()
    {
        var serverReceiveTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        // Read binary body directly
        using var ms = new MemoryStream();
        await Request.Body.CopyToAsync(ms);
        var payloadSize = (int)ms.Length;

        // Get client timestamp from header for accurate timing
        long uploadTimeMs = 100; // fallback
        if (Request.Headers.TryGetValue("X-Client-Timestamp", out var timestampHeader) &&
            long.TryParse(timestampHeader, out var clientTimestamp))
        {
            uploadTimeMs = serverReceiveTime - clientTimestamp;
            // Ensure reasonable bounds (account for clock skew)
            if (uploadTimeMs < 10) uploadTimeMs = 10;
            if (uploadTimeMs > 30000) uploadTimeMs = 30000; // 30s max
        }

        var result = _speedTestService.CalculateSpeed(payloadSize, uploadTimeMs);

        return Ok(result);
    }
}

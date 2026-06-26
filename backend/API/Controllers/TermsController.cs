using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using WatchTogether.Data.Repositories;
using System.Security.Claims;

namespace WatchTogether.API.Controllers;

[ApiController]
[Route("api/[controller]")]
public class TermsController : ControllerBase
{
    private readonly IUserRepository _userRepository;
    private const string CurrentTermsVersion = "1.0";

    public TermsController(IUserRepository userRepository)
    {
        _userRepository = userRepository;
    }

    [HttpGet("current")]
    public IActionResult GetCurrentTerms()
    {
        var terms = new
        {
            version = CurrentTermsVersion,
            lastUpdated = "2024-01-01",
            content = @"
# Terms and Conditions

## 1. Acceptance of Terms
By using WatchTogether, you agree to be bound by these Terms and Conditions.

## 2. Use of Service
WatchTogether is a private video sharing platform. You agree to:
- Use the service only for lawful purposes
- Not share access credentials with unauthorized users
- Not attempt to circumvent any security measures
- Not upload or share illegal or copyrighted content

## 3. Privacy
- We collect minimal data necessary to provide the service
- Your email is used for authentication and notifications
- Video streams are peer-to-peer and not stored on our servers
- Session data is temporary and deleted after sessions end

## 4. Invitation System
- Users may invite others using their allocated invitation slots
- You are responsible for who you invite to the platform
- Invitations can be revoked at the discretion of administrators

## 5. Content Guidelines
- Do not stream illegal content
- Do not use the service for harassment or abuse
- Respect other users and their privacy

## 6. Termination
We reserve the right to terminate accounts that violate these terms.

## 7. Changes to Terms
We may update these terms at any time. Continued use constitutes acceptance.

## 8. Limitation of Liability
WatchTogether is provided ""as is"" without warranty. We are not liable for any damages arising from use of the service.

By continuing to use WatchTogether, you acknowledge that you have read, understood, and agree to these terms.
"
        };

        return Ok(terms);
    }

    [HttpPost("accept")]
    [Authorize]
    public async Task<IActionResult> AcceptTerms()
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (string.IsNullOrEmpty(userId))
        {
            return Unauthorized();
        }

        var user = await _userRepository.GetByIdAsync(userId);
        if (user == null)
        {
            return NotFound(new { message = "User not found" });
        }

        user.AcceptedTermsAt = DateTime.UtcNow;
        user.TermsVersion = CurrentTermsVersion;
        await _userRepository.UpdateAsync(user);

        return Ok(new { success = true, message = "Terms accepted" });
    }
}

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using WatchTogether.Business.Services;
using WatchTogether.Data.Repositories;
using WatchTogether.Data.Entities;
using System.Security.Claims;

namespace WatchTogether.API.Controllers;

[ApiController]
[Route("api/[controller]")]
[Authorize]
public class AdminController : ControllerBase
{
    private readonly IUserRepository _userRepository;
    private readonly IInvitationRepository _invitationRepository;
    private readonly IAdminAuditLogRepository _auditLogRepository;
    private readonly IDemoRequestService _demoRequestService;

    public AdminController(
        IUserRepository userRepository,
        IInvitationRepository invitationRepository,
        IAdminAuditLogRepository auditLogRepository,
        IDemoRequestService demoRequestService)
    {
        _userRepository = userRepository;
        _invitationRepository = invitationRepository;
        _auditLogRepository = auditLogRepository;
        _demoRequestService = demoRequestService;
    }

    /// <summary>
    /// Append a record of an admin action to the audit log. Captures the
    /// authenticated actor, the action label, the target, and the client IP
    /// (already rewritten by the forwarded-headers middleware to be the real
    /// client, not the Railway edge proxy).
    /// </summary>
    private Task WriteAuditAsync(string action, string targetType, string targetId, string? details = null)
    {
        return _auditLogRepository.AppendAsync(new AdminAuditLog
        {
            ActorUserId = User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "unknown",
            ActorEmail = User.FindFirstValue(ClaimTypes.Email),
            Action = action,
            TargetType = targetType,
            TargetId = targetId,
            Details = details,
            IpAddress = HttpContext.Connection.RemoteIpAddress?.ToString(),
        });
    }

    private async Task<bool> IsRootUser()
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (string.IsNullOrEmpty(userId)) return false;

        var user = await _userRepository.GetByIdAsync(userId);
        return user?.IsRootUser ?? false;
    }

    [HttpGet("users")]
    public async Task<IActionResult> GetAllUsers()
    {
        if (!await IsRootUser())
        {
            return Forbid();
        }

        var users = await _userRepository.GetAllAsync();
        var userDtos = users.Select(u => new
        {
            id = u.Id,
            email = u.Email,
            displayName = u.DisplayName,
            isRootUser = u.IsRootUser,
            isEmailVerified = u.IsEmailVerified,
            isInvitationTicketUsed = u.IsInvitationTicketUsed,
            invitedByUserId = u.InvitedByUserId,
            createdAt = u.CreatedAt,
            hasAcceptedTerms = u.AcceptedTermsAt.HasValue
        });

        return Ok(userDtos);
    }

    [HttpGet("user-tree")]
    public async Task<IActionResult> GetUserTree()
    {
        if (!await IsRootUser())
        {
            return Forbid();
        }

        var users = await _userRepository.GetAllAsync();
        var userList = users.ToList();

        // Build tree structure
        var rootUser = userList.FirstOrDefault(u => u.IsRootUser);
        if (rootUser == null)
        {
            return Ok(new { root = (object?)null, users = Array.Empty<object>() });
        }

        var tree = BuildUserNode(rootUser, userList);

        return Ok(new { root = tree, totalUsers = userList.Count });
    }

    private object BuildUserNode(User user, List<User> allUsers)
    {
        var children = allUsers
            .Where(u => u.InvitedByUserId == user.Id)
            .Select(u => BuildUserNode(u, allUsers))
            .ToList();

        return new
        {
            id = user.Id,
            displayName = user.DisplayName,
            email = user.Email,
            isRootUser = user.IsRootUser,
            isEmailVerified = user.IsEmailVerified,
            createdAt = user.CreatedAt,
            children
        };
    }

    [HttpGet("invitations")]
    public async Task<IActionResult> GetAllInvitations()
    {
        if (!await IsRootUser())
        {
            return Forbid();
        }

        var invitations = await _invitationRepository.GetAllAsync();
        var invitationDtos = invitations.Select(i => new
        {
            id = i.Id,
            inviterUserId = i.InviterUserId,
            inviteeEmail = i.InviteeEmail,
            status = i.Status.ToString(),
            createdAt = i.CreatedAt,
            expiresAt = i.ExpiresAt,
            usedAt = i.UsedAt,
            registeredUserId = i.RegisteredUserId
        });

        return Ok(invitationDtos);
    }

    [HttpPut("users/{id}")]
    public async Task<IActionResult> UpdateUser(string id, [FromBody] UpdateUserDto dto)
    {
        if (!ObjectId.TryParse(id, out _)) return BadRequest(new { message = "Invalid user id" });
        if (!await IsRootUser())
        {
            return Forbid();
        }

        var user = await _userRepository.GetByIdAsync(id);
        if (user == null)
        {
            return NotFound(new { message = "User not found" });
        }

        // Don't allow editing the root user's root status
        if (user.IsRootUser && dto.IsRootUser == false)
        {
            return BadRequest(new { message = "Cannot remove root status from root user" });
        }

        if (!string.IsNullOrEmpty(dto.DisplayName))
        {
            user.DisplayName = dto.DisplayName;
        }

        if (!string.IsNullOrEmpty(dto.Email))
        {
            // Normalize the same way the registration paths do — lowercase + trim,
            // with the invariant culture so a tr-TR server doesn't lower "I" to "ı"
            // and break the case-sensitive unique index assumption everything else
            // relies on. Without this, an admin typing "Foo@Example.com" would
            // store mixed-case and ExistsAsync("foo@example.com") would no longer
            // find the row — silently letting a duplicate account through.
            var normalizedEmail = dto.Email.ToLowerInvariant().Trim();
            if (!System.Text.RegularExpressions.Regex.IsMatch(normalizedEmail, @"^[^@\s]+@[^@\s]+\.[^@\s]+$"))
            {
                return BadRequest(new { message = "Invalid email format" });
            }
            // Pre-check for collision with another user — the unique index would
            // throw a duplicate-key on save, but catching it here gives the admin
            // a clean 400 with a friendly message instead of a 500.
            if (normalizedEmail != user.Email && await _userRepository.ExistsAsync(normalizedEmail))
            {
                return BadRequest(new { message = "Another user already has this email" });
            }
            user.Email = normalizedEmail;
        }

        if (dto.IsEmailVerified.HasValue)
        {
            user.IsEmailVerified = dto.IsEmailVerified.Value;
        }

        await _userRepository.UpdateAsync(user);

        // Audit trail: only log the fields the admin actually touched.
        // Avoids dumping the full user object (PII) into the log.
        var changes = new List<string>();
        if (!string.IsNullOrEmpty(dto.DisplayName)) changes.Add($"displayName={dto.DisplayName}");
        if (!string.IsNullOrEmpty(dto.Email)) changes.Add($"email={dto.Email}");
        if (dto.IsEmailVerified.HasValue) changes.Add($"isEmailVerified={dto.IsEmailVerified.Value}");
        await WriteAuditAsync("UpdateUser", "User", id, string.Join("; ", changes));

        return Ok(new { message = "User updated successfully" });
    }

    [HttpDelete("users/{id}")]
    public async Task<IActionResult> DeleteUser(string id)
    {
        if (!ObjectId.TryParse(id, out _)) return BadRequest(new { message = "Invalid user id" });
        if (!await IsRootUser())
        {
            return Forbid();
        }

        var user = await _userRepository.GetByIdAsync(id);
        if (user == null)
        {
            return NotFound(new { message = "User not found" });
        }

        if (user.IsRootUser)
        {
            return BadRequest(new { message = "Cannot delete root user" });
        }

        // H8 fix: soft delete with anonymization instead of physical removal.
        // Keeps the row alive so child users' InvitedByUserId still resolves
        // (admin tree builder no longer drops grandchildren past a deleted
        // parent), but clears PII fields for GDPR right-to-erasure.
        var actorId = User.FindFirst(ClaimTypes.NameIdentifier)?.Value ?? "unknown";
        await _userRepository.SoftDeleteAsync(id, actorId);

        // Audit: capture the pre-anonymization email so the trail is meaningful
        // even after the User row's PII fields are cleared.
        await WriteAuditAsync("DeleteUser", "User", id, $"previousEmail={user.Email}");

        return Ok(new { message = "User deleted successfully" });
    }

    [HttpDelete("invitations/{id}")]
    public async Task<IActionResult> DeleteInvitation(string id)
    {
        if (!ObjectId.TryParse(id, out _)) return BadRequest(new { message = "Invalid invitation id" });
        if (!await IsRootUser())
        {
            return Forbid();
        }

        var invitation = await _invitationRepository.GetByIdAsync(id);
        if (invitation == null)
        {
            return NotFound(new { message = "Invitation not found" });
        }

        await _invitationRepository.DeleteAsync(id);
        await WriteAuditAsync("DeleteInvitation", "Invitation", id, $"inviteeEmail={invitation.InviteeEmail}");

        return Ok(new { message = "Invitation deleted successfully" });
    }

    /// <summary>
    /// Read the recent admin audit log. Limit param caps result count
    /// (default 100, max 500). Returns chronological-desc.
    /// </summary>
    [HttpGet("audit-log")]
    public async Task<IActionResult> GetAuditLog([FromQuery] int limit = 100)
    {
        if (!await IsRootUser())
        {
            return Forbid();
        }
        limit = Math.Clamp(limit, 1, 500);
        var entries = await _auditLogRepository.GetRecentAsync(limit);
        return Ok(entries);
    }

    [HttpGet("demo-requests")]
    public async Task<IActionResult> GetDemoRequests()
    {
        if (!await IsRootUser())
        {
            return Forbid();
        }

        var requests = await _demoRequestService.ListAsync();
        var dtos = requests.Select(r => new
        {
            id = r.Id,
            email = r.Email,
            displayName = r.DisplayName,
            message = r.Message,
            status = r.Status.ToString(),
            submittedAt = r.SubmittedAt,
            reviewedAt = r.ReviewedAt,
            reviewedByUserId = r.ReviewedByUserId,
            rejectionReason = r.RejectionReason
        });
        return Ok(dtos);
    }

    [HttpPost("demo-requests/{id}/approve")]
    public async Task<IActionResult> ApproveDemoRequest(string id)
    {
        if (!ObjectId.TryParse(id, out _)) return BadRequest(new { message = "Invalid request id" });
        if (!await IsRootUser())
        {
            return Forbid();
        }

        var actorId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (string.IsNullOrEmpty(actorId))
        {
            return Unauthorized();
        }

        var result = await _demoRequestService.ApproveAsync(id, actorId);
        if (!result.Success)
        {
            return BadRequest(new { message = result.Message });
        }

        await WriteAuditAsync("ApproveDemoRequest", "DemoRequest", id, $"invitationUrl issued, expiresAt={result.ExpiresAt:o}");

        return Ok(new
        {
            message = result.Message,
            invitationUrl = result.InvitationUrl,
            expiresAt = result.ExpiresAt
        });
    }

    [HttpPost("demo-requests/{id}/resend")]
    public async Task<IActionResult> ResendDemoRequestInvite(string id)
    {
        if (!ObjectId.TryParse(id, out _)) return BadRequest(new { message = "Invalid request id" });
        if (!await IsRootUser())
        {
            return Forbid();
        }

        var actorId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (string.IsNullOrEmpty(actorId))
        {
            return Unauthorized();
        }

        var result = await _demoRequestService.ResendInviteAsync(id, actorId);
        if (!result.Success)
        {
            return BadRequest(new { message = result.Message });
        }

        await WriteAuditAsync("ResendDemoInvite", "DemoRequest", id, $"new link issued, expiresAt={result.ExpiresAt:o}");

        return Ok(new
        {
            message = result.Message,
            invitationUrl = result.InvitationUrl,
            expiresAt = result.ExpiresAt
        });
    }

    [HttpPost("demo-requests/{id}/reject")]
    public async Task<IActionResult> RejectDemoRequest(string id, [FromBody] RejectDemoRequestDto? dto)
    {
        if (!ObjectId.TryParse(id, out _)) return BadRequest(new { message = "Invalid request id" });
        if (!await IsRootUser())
        {
            return Forbid();
        }

        var actorId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (string.IsNullOrEmpty(actorId))
        {
            return Unauthorized();
        }

        var ok = await _demoRequestService.RejectAsync(id, actorId, dto?.Reason);
        if (!ok)
        {
            return BadRequest(new { message = "Request not found or not pending." });
        }

        await WriteAuditAsync("RejectDemoRequest", "DemoRequest", id, string.IsNullOrWhiteSpace(dto?.Reason) ? null : $"reason={dto.Reason}");
        return Ok(new { message = "Demo request rejected." });
    }
}

public class UpdateUserDto
{
    public string? DisplayName { get; set; }
    public string? Email { get; set; }
    public bool? IsEmailVerified { get; set; }
    public bool? IsRootUser { get; set; }
}

public class RejectDemoRequestDto
{
    public string? Reason { get; set; }
}

using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using WatchTogether.Business.DTOs;
using WatchTogether.Business.Services;
using WatchTogether.Data.Repositories;

namespace WatchTogether.API.Controllers;

[ApiController]
[Route("api/[controller]")]
[Authorize]
public class InvitationController : ControllerBase
{
    private readonly IInvitationService _invitationService;
    private readonly IInvitationLinkService _invitationLinkService;
    private readonly IUserRepository _userRepository;

    public InvitationController(
        IInvitationService invitationService,
        IInvitationLinkService invitationLinkService,
        IUserRepository userRepository)
    {
        _invitationService = invitationService;
        _invitationLinkService = invitationLinkService;
        _userRepository = userRepository;
    }

    [HttpGet("available-slots")]
    public async Task<IActionResult> GetAvailableSlots()
    {
        var userId = GetUserId();
        if (userId == null)
            return Unauthorized();

        var slots = await _invitationService.GetAvailableSlotsAsync(userId);

        return Ok(new InvitationSlotsResponse
        {
            MaxSlots = slots.MaxSlots,
            UsedSlots = slots.UsedSlots,
            PendingSlots = slots.PendingSlots,
            TrulyUsedSlots = slots.TrulyUsedSlots,
            RemainingSlots = slots.RemainingSlots,
            // Critical for root admin — the Lobby uses this flag to decide whether
            // MaxSlots is a real cap (regular user) or the int.MaxValue sentinel
            // (root). Forgetting it makes the frontend Array.from(maxSlots) loop
            // crash the tab on every root login.
            IsUnlimited = slots.IsUnlimited
        });
    }

    [HttpPost("create")]
    public async Task<IActionResult> CreateInvitation([FromBody] CreateInvitationRequest request)
    {
        var userId = GetUserId();
        if (userId == null)
            return Unauthorized();

        if (string.IsNullOrWhiteSpace(request.Email))
            return BadRequest(new { message = "Email is required" });

        var result = await _invitationService.CreateInvitationAsync(userId, request.Email);

        if (!result.Success)
            return BadRequest(new { message = result.Message });

        return Ok(new CreateInvitationResponse
        {
            Success = true,
            Message = result.Message,
            InvitationLink = result.InvitationLink,
            Invitation = result.Invitation != null ? new InvitationDto
            {
                Id = result.Invitation.Id,
                InviteeEmail = result.Invitation.InviteeEmail,
                Status = result.Invitation.Status.ToString(),
                CreatedAt = result.Invitation.CreatedAt,
                ExpiresAt = result.Invitation.ExpiresAt,
                UsedAt = result.Invitation.UsedAt
            } : null
        });
    }

    [HttpGet("my-invitations")]
    public async Task<IActionResult> GetMyInvitations()
    {
        var userId = GetUserId();
        if (userId == null)
            return Unauthorized();

        var invitations = await _invitationService.GetMyInvitationsAsync(userId);

        return Ok(invitations.Select(i => new InvitationDto
        {
            Id = i.Id,
            InviteeEmail = i.InviteeEmail,
            Status = i.Status.ToString(),
            CreatedAt = i.CreatedAt,
            ExpiresAt = i.ExpiresAt,
            UsedAt = i.UsedAt
        }));
    }

    [HttpDelete("{id}/revoke")]
    public async Task<IActionResult> RevokeInvitation(string id)
    {
        var userId = GetUserId();
        if (userId == null)
            return Unauthorized();

        var (success, message) = await _invitationService.RevokeInvitationAsync(id, userId);

        if (!success)
            return BadRequest(new { message });

        return Ok(new { message });
    }

    // ============================================
    // New link-based invitation endpoints
    // ============================================

    /// <summary>
    /// Generate a shareable invitation link (uses user's ticket).
    /// User can share this link via WhatsApp, Discord, etc.
    /// </summary>
    [HttpPost("generate-link")]
    public async Task<IActionResult> GenerateLink()
    {
        var userId = GetUserId();
        if (userId == null)
            return Unauthorized();

        var result = await _invitationLinkService.GenerateLinkAsync(userId);

        return Ok(new GenerateLinkResponse
        {
            Success = result.Success,
            Message = result.Message,
            InviteUrl = result.InviteUrl,
            ExpiresAt = result.ExpiresAt
        });
    }

    /// <summary>
    /// Validate an invitation token (called when friend clicks link).
    /// No auth required - this is for new users who don't have an account yet.
    /// </summary>
    [HttpGet("validate/{token}")]
    [AllowAnonymous]
    [EnableRateLimiting("invitation")]
    public async Task<IActionResult> ValidateLink(string token)
    {
        if (string.IsNullOrWhiteSpace(token))
            return BadRequest(new ValidateLinkResponse { Valid = false, Message = "Invalid link" });

        var result = await _invitationLinkService.ValidateLinkAsync(token);

        string? inviterDisplayName = null;
        if (result.Valid && result.InviterUserId != null)
        {
            var inviter = await _userRepository.GetByIdAsync(result.InviterUserId);
            inviterDisplayName = inviter?.DisplayName;
        }

        return Ok(new ValidateLinkResponse
        {
            Valid = result.Valid,
            Message = result.Message,
            InviterDisplayName = inviterDisplayName
        });
    }

    /// <summary>
    /// Get the user's current active invitation link (if any)
    /// </summary>
    [HttpGet("active-link")]
    public async Task<IActionResult> GetActiveLink()
    {
        var userId = GetUserId();
        if (userId == null)
            return Unauthorized();

        var activeLink = await _invitationLinkService.GetActiveLinkAsync(userId);

        if (activeLink == null)
        {
            return Ok(new ActiveLinkResponse { HasActiveLink = false });
        }

        // Note: We can't return the URL since we only store the hash
        // User needs to save the URL when they first generate it
        return Ok(new ActiveLinkResponse
        {
            HasActiveLink = true,
            ExpiresAt = activeLink.ExpiresAt
        });
    }

    /// <summary>
    /// Revoke the user's active invitation link (returns ticket)
    /// </summary>
    [HttpDelete("revoke-link")]
    public async Task<IActionResult> RevokeLink()
    {
        var userId = GetUserId();
        if (userId == null)
            return Unauthorized();

        var (success, message) = await _invitationLinkService.RevokeLinkAsync(userId);

        if (!success)
            return BadRequest(new { message });

        return Ok(new { message });
    }

    private string? GetUserId()
    {
        return User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
    }
}

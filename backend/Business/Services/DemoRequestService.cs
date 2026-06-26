using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using WatchTogether.Data.Entities;
using WatchTogether.Data.Repositories;

namespace WatchTogether.Business.Services;

public class DemoRequestService : IDemoRequestService
{
    private readonly IDemoRequestRepository _demoRequestRepository;
    private readonly IUserRepository _userRepository;
    private readonly IInvitationLinkService _invitationLinkService;
    private readonly IEmailService _emailService;
    private readonly IConfiguration _configuration;
    private readonly ILogger<DemoRequestService> _logger;

    private const int MAX_MESSAGE_LENGTH = 500;
    private const int MAX_DISPLAY_NAME_LENGTH = 80;

    public DemoRequestService(
        IDemoRequestRepository demoRequestRepository,
        IUserRepository userRepository,
        IInvitationLinkService invitationLinkService,
        IEmailService emailService,
        IConfiguration configuration,
        ILogger<DemoRequestService> logger)
    {
        _demoRequestRepository = demoRequestRepository;
        _userRepository = userRepository;
        _invitationLinkService = invitationLinkService;
        _emailService = emailService;
        _configuration = configuration;
        _logger = logger;
    }

    public async Task<SubmitDemoRequestResult> SubmitAsync(
        string email,
        string displayName,
        string? message,
        string? clientIp)
    {
        // Normalize before validation so "Foo@Example.com  " and "foo@example.com"
        // collide on the duplicate-pending check. ToLowerInvariant — not ToLower —
        // so a tr-TR server doesn't lower "I" to "ı" and silently let a duplicate
        // through (same precedent as AuthService).
        var normalizedEmail = (email ?? "").ToLowerInvariant().Trim();
        var trimmedName = (displayName ?? "").Trim();
        var trimmedMessage = string.IsNullOrWhiteSpace(message) ? null : message.Trim();

        if (string.IsNullOrWhiteSpace(normalizedEmail) ||
            !System.Text.RegularExpressions.Regex.IsMatch(normalizedEmail, @"^[^@\s]+@[^@\s]+\.[^@\s]+$"))
        {
            return new SubmitDemoRequestResult { Success = false, Message = "Please enter a valid email address." };
        }

        if (string.IsNullOrWhiteSpace(trimmedName))
        {
            return new SubmitDemoRequestResult { Success = false, Message = "Please tell us your name." };
        }

        if (trimmedName.Length > MAX_DISPLAY_NAME_LENGTH)
        {
            return new SubmitDemoRequestResult { Success = false, Message = "Name is too long." };
        }

        if (trimmedMessage is { Length: > MAX_MESSAGE_LENGTH })
        {
            return new SubmitDemoRequestResult { Success = false, Message = "Message is too long." };
        }

        // Idempotent re-submission. If a Pending request from this email already
        // exists, do nothing and return success uniformly — don't burn extra
        // admin-notification emails on the same person resubmitting, and don't
        // leak "we already have you" to a probing attacker.
        if (await _demoRequestRepository.HasPendingByEmailAsync(normalizedEmail))
        {
            return new SubmitDemoRequestResult
            {
                Success = true,
                Message = "Thanks — we'll be in touch soon."
            };
        }

        var demoRequest = new DemoRequest
        {
            Email = normalizedEmail,
            DisplayName = trimmedName,
            Message = trimmedMessage,
            Status = DemoRequestStatus.Pending,
            SubmittedAt = DateTime.UtcNow,
            SubmittedFromIp = clientIp
        };

        await _demoRequestRepository.CreateAsync(demoRequest);

        // Best-effort admin notification. We deliberately swallow failures so an
        // SMTP outage doesn't surface as a user-visible "submission failed"
        // message; the demo request itself is durable in Mongo and the admin
        // will still see it in the panel.
        try
        {
            var rootUser = await FindRootAdminAsync();
            if (rootUser != null)
            {
                var frontendUrl = _configuration["App:FrontendUrl"] ?? "http://localhost:5173";
                var adminPanelUrl = $"{frontendUrl}/admin";
                await _emailService.SendDemoRequestNotificationAsync(
                    rootUser.Email,
                    normalizedEmail,
                    trimmedName,
                    trimmedMessage,
                    adminPanelUrl);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[DemoRequestService] Admin notification failed (non-fatal)");
        }

        return new SubmitDemoRequestResult
        {
            Success = true,
            Message = "Thanks — we'll be in touch soon."
        };
    }

    public Task<List<DemoRequest>> ListAsync()
    {
        return _demoRequestRepository.GetAllAsync();
    }

    public async Task<ApproveDemoRequestResult> ApproveAsync(string requestId, string approverUserId)
    {
        var request = await _demoRequestRepository.GetByIdAsync(requestId);
        if (request == null)
        {
            return new ApproveDemoRequestResult { Success = false, Message = "Request not found." };
        }

        if (request.Status != DemoRequestStatus.Pending)
        {
            return new ApproveDemoRequestResult
            {
                Success = false,
                Message = $"Request already {request.Status.ToString().ToLowerInvariant()}."
            };
        }

        // Generate the one-time invite link under the approving admin's slot
        // pool. Root admins have unlimited tickets (ROOT_USER_MAX_INVITES =
        // UNLIMITED_INVITES) so this never trips the quota.
        var linkResult = await _invitationLinkService.GenerateLinkAsync(approverUserId);
        if (!linkResult.Success || linkResult.InviteUrl == null)
        {
            return new ApproveDemoRequestResult
            {
                Success = false,
                Message = linkResult.Message ?? "Failed to generate invitation link."
            };
        }

        // Mark the request approved BEFORE sending email so a flaky SMTP
        // attempt doesn't leave the request stuck "pending" while a link
        // has already been burned.
        request.Status = DemoRequestStatus.Approved;
        request.ReviewedAt = DateTime.UtcNow;
        request.ReviewedByUserId = approverUserId;
        // InvitationLinkId isn't surfaced through GenerateLinkResult today —
        // we keep the field nullable and could backfill via a service lookup
        // if a future feature needs to join from the request to the link.
        await _demoRequestRepository.UpdateAsync(request);

        // Email is best-effort: if it fails, the admin can still copy the URL
        // from the approval response and send manually. We surface success
        // either way because the link IS already valid in the DB.
        try
        {
            await _emailService.SendDemoRequestApprovedAsync(
                request.Email,
                request.DisplayName,
                linkResult.InviteUrl);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[DemoRequestService] Approval email failed (non-fatal)");
        }

        return new ApproveDemoRequestResult
        {
            Success = true,
            Message = "Demo request approved and invitation sent.",
            InvitationUrl = linkResult.InviteUrl,
            ExpiresAt = linkResult.ExpiresAt
        };
    }

    public async Task<bool> RejectAsync(string requestId, string approverUserId, string? reason)
    {
        var request = await _demoRequestRepository.GetByIdAsync(requestId);
        if (request == null || request.Status != DemoRequestStatus.Pending)
        {
            return false;
        }

        request.Status = DemoRequestStatus.Rejected;
        request.ReviewedAt = DateTime.UtcNow;
        request.ReviewedByUserId = approverUserId;
        request.RejectionReason = string.IsNullOrWhiteSpace(reason) ? null : reason.Trim();
        await _demoRequestRepository.UpdateAsync(request);
        return true;
    }

    public async Task<ApproveDemoRequestResult> ResendInviteAsync(string requestId, string actorUserId)
    {
        var request = await _demoRequestRepository.GetByIdAsync(requestId);
        if (request == null)
        {
            return new ApproveDemoRequestResult { Success = false, Message = "Request not found." };
        }

        if (request.Status != DemoRequestStatus.Approved)
        {
            return new ApproveDemoRequestResult
            {
                Success = false,
                Message = $"Can only resend invitations for approved requests (current status: {request.Status})."
            };
        }

        // Same path as ApproveAsync: generate a fresh single-use link under the
        // current admin's slot pool. We deliberately do NOT revoke the previous
        // link — both stay valid until natural expiry. If the requester clicks
        // either one and registers, the other becomes "Used" (single-use semantics
        // are enforced at the InvitationLink level, not here).
        var linkResult = await _invitationLinkService.GenerateLinkAsync(actorUserId);
        if (!linkResult.Success || linkResult.InviteUrl == null)
        {
            return new ApproveDemoRequestResult
            {
                Success = false,
                Message = linkResult.Message ?? "Failed to generate invitation link."
            };
        }

        try
        {
            await _emailService.SendDemoRequestApprovedAsync(
                request.Email,
                request.DisplayName,
                linkResult.InviteUrl);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[DemoRequestService] Resend email failed (non-fatal)");
        }

        return new ApproveDemoRequestResult
        {
            Success = true,
            Message = "Fresh invitation sent.",
            InvitationUrl = linkResult.InviteUrl,
            ExpiresAt = linkResult.ExpiresAt
        };
    }

    private async Task<User?> FindRootAdminAsync()
    {
        // No dedicated repo method exists. GetAllAsync() returns < ~50 rows in
        // this app's lifetime; FirstOrDefault scan is fine. If the user base
        // ever grows past a few thousand, replace with a targeted repo query.
        var users = await _userRepository.GetAllAsync();
        return users.FirstOrDefault(u => u.IsRootUser && !u.IsDeleted);
    }
}

using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Configuration;
using WatchTogether.Data.Entities;
using WatchTogether.Data.Repositories;

namespace WatchTogether.Business.Services;

public class InvitationService : IInvitationService
{
    private readonly IUserRepository _userRepository;
    private readonly IInvitationRepository _invitationRepository;
    private readonly IInvitationLinkRepository _invitationLinkRepository;
    private readonly IEmailService _emailService;
    private readonly IConfiguration _configuration;

    /// <summary>
    /// Sentinel used when a user has no quota cap (root). The atomic
    /// <c>TryReserveSlotAsync</c> filter <c>activeLinkCount &lt; maxSlots</c>
    /// always passes against this value (counter would have to overflow first),
    /// and the frontend interprets the matching <c>IsUnlimited=true</c> flag as
    /// "render ∞ instead of the raw number." Picking int.MaxValue (vs. e.g.
    /// 1_000_000) means there's no awkward "you ran out" surprise if a root
    /// somehow generated millions of links — and the comparison stays a single
    /// 32-bit int test in Mongo.
    /// </summary>
    public const int UNLIMITED_INVITES = int.MaxValue;

    /// <summary>Root user (the admin who originally deployed this instance) has
    /// no quota — they need to seed the user graph and invite as many friends
    /// as they want. Everyone else they invite gets <see cref="REGULAR_USER_MAX_INVITES"/>.</summary>
    public const int ROOT_USER_MAX_INVITES = UNLIMITED_INVITES;
    public const int REGULAR_USER_MAX_INVITES = 1;

    public InvitationService(
        IUserRepository userRepository,
        IInvitationRepository invitationRepository,
        IInvitationLinkRepository invitationLinkRepository,
        IEmailService emailService,
        IConfiguration configuration)
    {
        _userRepository = userRepository;
        _invitationRepository = invitationRepository;
        _invitationLinkRepository = invitationLinkRepository;
        _emailService = emailService;
        _configuration = configuration;
    }

    public async Task<InvitationSlotInfo> GetAvailableSlotsAsync(string userId)
    {
        var user = await _userRepository.GetByIdAsync(userId);
        if (user == null)
        {
            return new InvitationSlotInfo { MaxSlots = 0, UsedSlots = 0, RemainingSlots = 0 };
        }

        var isUnlimited = user.IsRootUser;
        var maxSlots = isUnlimited ? UNLIMITED_INVITES : REGULAR_USER_MAX_INVITES;
        var pendingSlots = (int)await _invitationLinkRepository.CountPendingByInviterAsync(userId);
        var trulyUsedSlots = (int)await _invitationLinkRepository.CountTrulyUsedByInviterAsync(userId);
        var usedSlots = pendingSlots + trulyUsedSlots;

        // For unlimited users we skip the subtraction — int.MaxValue - usedSlots
        // is still huge, but exposing it raw would let a buggy frontend render
        // "2147483646 left" which is just visual noise. Mirror MaxSlots so a
        // dumb client that ignores IsUnlimited at least gets a consistent pair.
        var remainingSlots = isUnlimited
            ? UNLIMITED_INVITES
            : Math.Max(0, maxSlots - usedSlots);

        return new InvitationSlotInfo
        {
            MaxSlots = maxSlots,
            UsedSlots = usedSlots,
            PendingSlots = pendingSlots,
            TrulyUsedSlots = trulyUsedSlots,
            RemainingSlots = remainingSlots,
            IsUnlimited = isUnlimited,
        };
    }

    public async Task<CreateInvitationResult> CreateInvitationAsync(string inviterUserId, string inviteeEmail)
    {
        // Get inviter
        var inviter = await _userRepository.GetByIdAsync(inviterUserId);
        if (inviter == null)
        {
            return new CreateInvitationResult
            {
                Success = false,
                Message = "User not found"
            };
        }

        // Check slots
        var slots = await GetAvailableSlotsAsync(inviterUserId);
        if (slots.RemainingSlots <= 0)
        {
            return new CreateInvitationResult
            {
                Success = false,
                Message = "You have no invitation slots remaining"
            };
        }

        // Reject malformed emails before they hit the unique index or the mail
        // send. Same shape used by AdminController + DemoRequestService — keep in
        // sync. Validate the raw (trimmed) value; ToLowerInvariant can't be called
        // on null, so this guard also closes the NRE on the line below.
        if (string.IsNullOrWhiteSpace(inviteeEmail) ||
            !System.Text.RegularExpressions.Regex.IsMatch(
                inviteeEmail.Trim(), @"^[^@\s]+@[^@\s]+\.[^@\s]+$"))
        {
            return new CreateInvitationResult
            {
                Success = false,
                Message = "Invalid email format"
            };
        }

        // Normalize email. ToLowerInvariant (not ToLower) so a tr-TR-locale server
        // can't lower "I" → "ı" — that would silently desync from the lowercase
        // emails written by every other path and break the unique-on-email index.
        var normalizedEmail = inviteeEmail.ToLowerInvariant().Trim();

        // Check if user already exists
        if (await _userRepository.ExistsAsync(normalizedEmail))
        {
            return new CreateInvitationResult
            {
                Success = false,
                Message = "A user with this email already exists"
            };
        }

        // Check for existing pending invitation
        var existingInvitations = await _invitationRepository.GetByInviterUserIdAsync(inviterUserId);
        var pendingForEmail = existingInvitations.FirstOrDefault(i =>
            i.InviteeEmail.ToLowerInvariant() == normalizedEmail &&
            i.Status == InvitationStatus.Pending);

        if (pendingForEmail != null)
        {
            return new CreateInvitationResult
            {
                Success = false,
                Message = "You already have a pending invitation for this email"
            };
        }

        // Generate plaintext token. Only goes into the outgoing email link —
        // never persisted in cleartext. At rest we store the BCrypt hash (in
        // InvitationToken) + SHA-256 hex for fast lookup (in TokenLookup).
        var token = GenerateInvitationToken();
        var tokenHash = BCrypt.Net.BCrypt.HashPassword(token);
        var tokenLookup = Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(token)));
        var expiryDays = int.TryParse(_configuration["Email:InvitationExpiryDays"], out var parsedExpiryDays) ? parsedExpiryDays : 7;
        var frontendUrl = _configuration["App:FrontendUrl"] ?? "http://localhost:5173";

        // Create invitation
        var invitation = new Invitation
        {
            InviterUserId = inviterUserId,
            InviteeEmail = normalizedEmail,
            InvitationToken = tokenHash,
            TokenLookup = tokenLookup,
            Status = InvitationStatus.Pending,
            CreatedAt = DateTime.UtcNow,
            ExpiresAt = DateTime.UtcNow.AddDays(expiryDays)
        };

        await _invitationRepository.CreateAsync(invitation);

        // Generate invitation link
        var invitationLink = $"{frontendUrl}/register/{token}";

        // Send email
        await _emailService.SendInvitationEmailAsync(normalizedEmail, inviter.DisplayName, invitationLink);

        return new CreateInvitationResult
        {
            Success = true,
            Message = "Invitation sent successfully",
            InvitationLink = invitationLink,
            Invitation = invitation
        };
    }

    public async Task<List<Invitation>> GetMyInvitationsAsync(string userId)
    {
        return await _invitationRepository.GetByInviterUserIdAsync(userId);
    }

    public async Task<List<Invitation>> GetAllInvitationsAsync()
    {
        return await _invitationRepository.GetAllAsync();
    }

    public async Task<(bool Success, string Message)> RevokeInvitationAsync(string invitationId, string userId)
    {
        var invitation = await _invitationRepository.GetByIdAsync(invitationId);

        if (invitation == null)
        {
            return (false, "Invitation not found");
        }

        // Check ownership (unless admin - which we'll check in controller)
        if (invitation.InviterUserId != userId)
        {
            return (false, "You don't have permission to revoke this invitation");
        }

        if (invitation.Status != InvitationStatus.Pending)
        {
            return (false, "Only pending invitations can be revoked");
        }

        invitation.Status = InvitationStatus.Revoked;
        await _invitationRepository.UpdateAsync(invitation);

        return (true, "Invitation revoked successfully");
    }

    private static string GenerateInvitationToken()
    {
        // Generate a URL-safe random token
        var bytes = new byte[32];
        RandomNumberGenerator.Fill(bytes);
        return Convert.ToBase64String(bytes)
            .Replace("+", "-")
            .Replace("/", "_")
            .Replace("=", "");
    }
}

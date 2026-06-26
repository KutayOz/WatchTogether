using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Configuration;
using WatchTogether.Data.Entities;
using WatchTogether.Data.Repositories;

namespace WatchTogether.Business.Services;

public class InvitationLinkService : IInvitationLinkService
{
    private readonly IUserRepository _userRepository;
    private readonly IInvitationLinkRepository _linkRepository;
    private readonly IConfiguration _configuration;

    private const int LINK_EXPIRY_HOURS = 48;

    public InvitationLinkService(
        IUserRepository userRepository,
        IInvitationLinkRepository linkRepository,
        IConfiguration configuration)
    {
        _userRepository = userRepository;
        _linkRepository = linkRepository;
        _configuration = configuration;
    }

    private static int GetMaxSlots(User user) =>
        user.IsRootUser ? InvitationService.ROOT_USER_MAX_INVITES : InvitationService.REGULAR_USER_MAX_INVITES;

    public async Task<GenerateLinkResult> GenerateLinkAsync(string inviterUserId)
    {
        // Get inviter (needed for max-slots calculation based on root/regular)
        var inviter = await _userRepository.GetByIdAsync(inviterUserId);
        if (inviter == null)
        {
            return new GenerateLinkResult
            {
                Success = false,
                Message = "User not found"
            };
        }

        // Opportunistic cleanup first so expired tickets release their slot
        // BEFORE we try to reserve a new one. Without this, an inviter who used
        // their quota and waited for expiry might still see "no slots" if the
        // cleanup hasn't run yet.
        await ReturnExpiredTicketsAsync();

        var maxSlots = GetMaxSlots(inviter);

        // H7 fix: atomic quota reservation. Single-document FindOneAndUpdate
        // checks `activeLinkCount < maxSlots` AND `$inc(activeLinkCount, 1)` as
        // one Mongo operation. Two concurrent calls can no longer both pass the
        // gate — the second one finds the counter already at max and returns
        // false. Previously we did Count + Count + InsertOne, with a TOCTOU
        // window between every pair.
        var reserved = await _userRepository.TryReserveSlotAsync(inviterUserId, maxSlots);
        if (!reserved)
        {
            return new GenerateLinkResult
            {
                Success = false,
                Message = "You have used all of your invitation slots"
            };
        }

        // Generate cryptographically secure token (256 bits of entropy).
        var token = GenerateSecureToken();
        var tokenHash = HashToken(token);
        // SHA-256(token) hex string — the indexed lookup key that turns the O(n)
        // BCrypt scan into an O(1) point query on the anonymous validate endpoint.
        var tokenLookup = ComputeTokenLookup(token);

        var expiresAt = DateTime.UtcNow.AddHours(LINK_EXPIRY_HOURS);

        // Create invitation link
        var link = new InvitationLink
        {
            TokenHash = tokenHash,
            TokenLookup = tokenLookup,
            InviterUserId = inviterUserId,
            CreatedAt = DateTime.UtcNow,
            ExpiresAt = expiresAt
        };

        try
        {
            await _linkRepository.CreateAsync(link);
        }
        catch
        {
            // Compensating action: release the slot we reserved so the user
            // isn't stuck losing quota to an unrelated DB error.
            await _userRepository.ReleaseSlotAsync(inviterUserId);
            throw;
        }

        // Generate URL
        var frontendBaseUrl = _configuration["App:FrontendUrl"] ?? "http://localhost:5173";
        var inviteUrl = $"{frontendBaseUrl}/invite/{token}";

        return new GenerateLinkResult
        {
            Success = true,
            Message = "Invitation link generated successfully",
            InviteUrl = inviteUrl,
            ExpiresAt = expiresAt
        };
    }

    public async Task<ValidateLinkResult> ValidateLinkAsync(string token)
    {
        // Fast path: SHA-256(token) → indexed point query. Replaces the previous
        // "fetch ALL unused links and BCrypt-verify against each" loop, which was an
        // O(n) BCrypt amplifier on an anonymous endpoint and a textbook DoS vector.
        var tokenLookup = ComputeTokenLookup(token);
        var link = await _linkRepository.GetByTokenLookupAsync(tokenLookup);

        // Defense in depth: SHA-256 is collision-resistant for our threat model, but
        // we ALSO verify the BCrypt hash. If TokenLookup were ever tampered with in
        // the DB (insider threat), the BCrypt verify would catch the mismatch.
        if (link == null || !VerifyToken(token, link.TokenHash))
        {
            // No match — opportunistically clean up expired tickets so inviters get them back.
            await ReturnExpiredTicketsAsync();
            return new ValidateLinkResult
            {
                Valid = false,
                Message = "Invalid invitation link"
            };
        }

        if (link.UsedAt != null || link.TicketReturned)
        {
            return new ValidateLinkResult
            {
                Valid = false,
                Message = "Invalid invitation link"
            };
        }

        if (link.ExpiresAt <= DateTime.UtcNow)
        {
            // Expired but not yet cleaned up — best-effort return the inviter's ticket now.
            await ReturnExpiredTicketsAsync();
            return new ValidateLinkResult
            {
                Valid = false,
                Message = "This invitation link has expired"
            };
        }

        return new ValidateLinkResult
        {
            Valid = true,
            InviterUserId = link.InviterUserId,
            InvitationLinkId = link.Id
        };
    }

    public async Task MarkLinkUsedAsync(string linkId, string registeredUserId)
    {
        var link = await _linkRepository.GetByIdAsync(linkId);
        if (link == null) return;

        link.UsedAt = DateTime.UtcNow;
        link.UsedByUserId = registeredUserId;
        await _linkRepository.UpdateAsync(link);
    }

    public async Task<InvitationLink?> GetActiveLinkAsync(string userId)
    {
        return await _linkRepository.GetActiveByInviterUserIdAsync(userId);
    }

    public async Task<(bool Success, string Message)> RevokeLinkAsync(string userId)
    {
        var activeLink = await _linkRepository.GetActiveByInviterUserIdAsync(userId);

        if (activeLink == null)
        {
            return (false, "No active invitation link to revoke");
        }

        // Delete the link first, then release the slot. H7 atomic counter
        // doesn't auto-derive from the link table — we have to maintain it
        // explicitly here and in ReturnExpiredTicketsAsync.
        await _linkRepository.DeleteAsync(activeLink.Id);
        await _userRepository.ReleaseSlotAsync(userId);

        return (true, "Invitation link revoked and ticket returned");
    }

    public async Task<int> ReturnExpiredTicketsAsync()
    {
        var expiredLinks = await _linkRepository.GetExpiredUnusedLinksAsync();
        var returnedCount = 0;

        foreach (var link in expiredLinks)
        {
            // Two-step: mark the link as returned (for audit / display state),
            // then release the slot on the inviter's atomic counter. Order matters
            // if a crash happens between: the link-marked-but-counter-not-released
            // state is recoverable (next startup's BackfillActiveLinkCounts would
            // re-sync), whereas counter-released-but-link-not-marked would let the
            // inviter exceed quota until next backfill.
            link.TicketReturned = true;
            await _linkRepository.UpdateAsync(link);
            await _userRepository.ReleaseSlotAsync(link.InviterUserId);
            returnedCount++;
        }

        return returnedCount;
    }

    private static string GenerateSecureToken()
    {
        // 32 bytes = 256 bits of entropy
        var bytes = new byte[32];
        RandomNumberGenerator.Fill(bytes);
        return Convert.ToBase64String(bytes)
            .Replace("+", "-")
            .Replace("/", "_")
            .Replace("=", "");
    }

    private static string HashToken(string token)
    {
        // Use BCrypt for secure token hashing
        return BCrypt.Net.BCrypt.HashPassword(token, BCrypt.Net.BCrypt.GenerateSalt(10));
    }

    private static bool VerifyToken(string token, string hash)
    {
        try
        {
            return BCrypt.Net.BCrypt.Verify(token, hash);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Deterministic SHA-256 (hex) of the token. Indexed in MongoDB so we can find
    /// the single matching link in O(1) instead of BCrypt-verifying against every row.
    /// </summary>
    internal static string ComputeTokenLookup(string token)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(token));
        return Convert.ToHexString(bytes); // uppercase hex; case doesn't matter for equality
    }
}

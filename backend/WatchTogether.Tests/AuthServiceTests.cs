using System.Net.Http;
using FluentAssertions;
using Microsoft.Extensions.Configuration;
using Moq;
using WatchTogether.Business.Services;
using WatchTogether.Data.Entities;
using WatchTogether.Data.Repositories;

namespace WatchTogether.Tests;

/// <summary>
/// AuthService is the security-critical service in the app — login, lockout,
/// email verification, password rehashing. Tests focus on observable contracts
/// (the return values + the side-effect repo calls). BCrypt itself isn't
/// mocked; the slowness it introduces (~400ms per Verify) means the suite
/// takes a few seconds, but mocking BCrypt would hide the very behavior we
/// care about (constant-time defense, work-factor upgrade).
///
/// Things deliberately NOT tested here:
///   - GoogleSignInAsync: relies on GoogleJsonWebSignature.ValidateAsync, a
///     static call that can't be intercepted without a wrapper interface.
///     A future "IGoogleTokenValidator" refactor would unblock this.
///   - Registration paths: they live in much longer methods with many DB
///     write side-effects worth its own focused test file.
/// </summary>
public class AuthServiceTests
{
    private const string ValidEmail = "alice@example.test";
    private const string ValidPassword = "Tr0ub4dor&3-with-extra-chars-for-strength";
    private const string JwtSecret = "test-jwt-secret-min-32-chars-long-please";

    private readonly Mock<IUserRepository> _userRepo = new();
    private readonly Mock<IInvitationRepository> _invRepo = new();
    private readonly Mock<IInvitationLinkService> _linkService = new();
    private readonly Mock<IInvitationService> _invService = new();
    private readonly Mock<IEmailService> _emailService = new();
    private readonly Mock<IHttpClientFactory> _httpFactory = new();
    private readonly IConfiguration _config;

    public AuthServiceTests()
    {
        _config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Jwt:Secret"] = JwtSecret,
                ["Jwt:Issuer"] = "test-issuer",
                ["Jwt:Audience"] = "test-audience",
                ["Jwt:ExpirationHours"] = "24",
                ["Email:VerificationTokenExpiryHours"] = "24",
                ["App:FrontendUrl"] = "https://app.test",
            })
            .Build();

        // Default: invitation service hands back "plenty of slots" so the
        // login response can be computed without extra setup per test.
        _invService
            .Setup(s => s.GetAvailableSlotsAsync(It.IsAny<string>()))
            .ReturnsAsync(new InvitationSlotInfo { MaxSlots = 5, UsedSlots = 0, RemainingSlots = 5 });
    }

    private AuthService NewService() => new(
        _userRepo.Object,
        _invRepo.Object,
        _linkService.Object,
        _invService.Object,
        _emailService.Object,
        _config,
        _httpFactory.Object);

    private static User UserWith(string password, Action<User>? mutate = null)
    {
        var user = new User
        {
            Id = "user-id-1",
            Email = ValidEmail,
            DisplayName = "Alice",
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(password, BCrypt.Net.BCrypt.GenerateSalt(12)),
            IsEmailVerified = true,
            CreatedAt = DateTime.UtcNow,
        };
        mutate?.Invoke(user);
        return user;
    }

    // ──────────────────────────────────────────────────────────────────
    // LoginAsync — happy path
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task LoginAsync_returns_token_and_user_info_on_correct_password()
    {
        var user = UserWith(ValidPassword);
        _userRepo.Setup(r => r.GetByEmailAsync(ValidEmail)).ReturnsAsync(user);

        var result = await NewService().LoginAsync(ValidEmail, ValidPassword);

        result.Should().NotBeNull();
        result!.Token.Should().NotBeNullOrEmpty();
        result.Email.Should().Be(ValidEmail);
        result.DisplayName.Should().Be("Alice");
        result.IsRootUser.Should().BeFalse();
    }

    [Fact]
    public async Task LoginAsync_clears_failed_attempt_counter_after_successful_login()
    {
        // User had 3 prior failures; correct password should reset to 0 and
        // write that back to the repo. The implementation skips the write
        // when the counter is already 0 (optimization), so we set it to 3.
        var user = UserWith(ValidPassword, u => u.FailedLoginAttempts = 3);
        _userRepo.Setup(r => r.GetByEmailAsync(ValidEmail)).ReturnsAsync(user);

        await NewService().LoginAsync(ValidEmail, ValidPassword);

        user.FailedLoginAttempts.Should().Be(0);
        user.LockedUntil.Should().BeNull();
        _userRepo.Verify(r => r.UpdateAsync(It.Is<User>(u => u.FailedLoginAttempts == 0)), Times.AtLeastOnce);
    }

    // ──────────────────────────────────────────────────────────────────
    // LoginAsync — every failure mode
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task LoginAsync_returns_null_when_user_not_found()
    {
        // The dummy-BCrypt branch is what makes the response timing
        // indistinguishable from "wrong password" — we can't time-test it in
        // a unit test reliably (BCrypt is the slow part either way), but at
        // least confirm the null return.
        _userRepo.Setup(r => r.GetByEmailAsync(ValidEmail)).ReturnsAsync((User?)null);

        var result = await NewService().LoginAsync(ValidEmail, ValidPassword);

        result.Should().BeNull();
        _userRepo.Verify(r => r.UpdateAsync(It.IsAny<User>()), Times.Never, "no user to update");
    }

    [Fact]
    public async Task LoginAsync_returns_null_and_increments_counter_on_wrong_password()
    {
        var user = UserWith(ValidPassword);
        _userRepo.Setup(r => r.GetByEmailAsync(ValidEmail)).ReturnsAsync(user);

        var result = await NewService().LoginAsync(ValidEmail, "obviously-not-the-password");

        result.Should().BeNull();
        user.FailedLoginAttempts.Should().Be(1);
        _userRepo.Verify(r => r.UpdateAsync(It.Is<User>(u => u.FailedLoginAttempts == 1)), Times.Once);
    }

    [Fact]
    public async Task LoginAsync_returns_null_when_user_is_currently_locked()
    {
        // The lockout window is computed by RegisterFailedLoginAsync; here we
        // pretend the user is already inside it. Even with correct password,
        // login should fail until the lock expires.
        var user = UserWith(ValidPassword, u =>
        {
            u.FailedLoginAttempts = 5;
            u.LockedUntil = DateTime.UtcNow.AddMinutes(10);
        });
        _userRepo.Setup(r => r.GetByEmailAsync(ValidEmail)).ReturnsAsync(user);

        var result = await NewService().LoginAsync(ValidEmail, ValidPassword);

        result.Should().BeNull();
        _userRepo.Verify(r => r.UpdateAsync(It.IsAny<User>()), Times.Never,
            "locked accounts shouldn't be touched");
    }

    [Fact]
    public async Task LoginAsync_allows_login_after_lockout_window_has_passed()
    {
        // LockedUntil in the past + correct password should succeed and clear
        // the counter — otherwise the soft-ban becomes a permanent ban.
        var user = UserWith(ValidPassword, u =>
        {
            u.FailedLoginAttempts = 5;
            u.LockedUntil = DateTime.UtcNow.AddMinutes(-5);
        });
        _userRepo.Setup(r => r.GetByEmailAsync(ValidEmail)).ReturnsAsync(user);

        var result = await NewService().LoginAsync(ValidEmail, ValidPassword);

        result.Should().NotBeNull();
        user.FailedLoginAttempts.Should().Be(0);
        user.LockedUntil.Should().BeNull();
    }

    [Fact]
    public async Task LoginAsync_locks_account_after_5_failed_attempts()
    {
        // Exact threshold check. The constant in the production code is 5;
        // attempt #5 should be the one that flips LockedUntil. The lockout
        // duration starts at 1 minute (1 << 0 = 1).
        var user = UserWith(ValidPassword, u => u.FailedLoginAttempts = 4);
        _userRepo.Setup(r => r.GetByEmailAsync(ValidEmail)).ReturnsAsync(user);

        var result = await NewService().LoginAsync(ValidEmail, "still-wrong");

        result.Should().BeNull();
        user.FailedLoginAttempts.Should().Be(5);
        user.LockedUntil.Should().NotBeNull("threshold reached, account locked");
        user.LockedUntil!.Value.Should().BeAfter(DateTime.UtcNow);
    }

    [Fact]
    public async Task LoginAsync_returns_null_for_google_only_user_with_no_password_hash()
    {
        // A Google-only account exists with no PasswordHash. Attempting
        // password login must fail like wrong-password (don't disclose that
        // the account uses Google — keeps the attack surface smaller).
        var user = new User
        {
            Id = "google-user",
            Email = ValidEmail,
            DisplayName = "Alice",
            PasswordHash = null,
            GoogleId = "google-sub-id",
            IsEmailVerified = true,
        };
        _userRepo.Setup(r => r.GetByEmailAsync(ValidEmail)).ReturnsAsync(user);

        var result = await NewService().LoginAsync(ValidEmail, "any-password");

        result.Should().BeNull();
        // Treated as a failed login attempt — same lockout protection as
        // wrong-password to slow down credential stuffing.
        user.FailedLoginAttempts.Should().Be(1);
    }

    [Fact]
    public async Task LoginAsync_returns_null_for_unverified_email_on_non_root_user()
    {
        var user = UserWith(ValidPassword, u =>
        {
            u.IsEmailVerified = false;
            u.IsRootUser = false;
        });
        _userRepo.Setup(r => r.GetByEmailAsync(ValidEmail)).ReturnsAsync(user);

        var result = await NewService().LoginAsync(ValidEmail, ValidPassword);

        result.Should().BeNull();
    }

    [Fact]
    public async Task LoginAsync_allows_root_user_even_when_email_unverified()
    {
        // Bootstrap escape hatch — admin account doesn't need verification.
        var user = UserWith(ValidPassword, u =>
        {
            u.IsEmailVerified = false;
            u.IsRootUser = true;
        });
        _userRepo.Setup(r => r.GetByEmailAsync(ValidEmail)).ReturnsAsync(user);

        var result = await NewService().LoginAsync(ValidEmail, ValidPassword);

        result.Should().NotBeNull();
        result!.IsRootUser.Should().BeTrue();
    }

    // ──────────────────────────────────────────────────────────────────
    // LoginAsync — rehash-on-login upgrade
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task LoginAsync_upgrades_low_work_factor_hash_to_current_factor()
    {
        // Stored hash at cost 10 (below target 12). After a successful
        // login the user's PasswordHash should be rewritten at cost 12.
        var oldHash = BCrypt.Net.BCrypt.HashPassword(ValidPassword, BCrypt.Net.BCrypt.GenerateSalt(10));
        var user = UserWith(ValidPassword, u => u.PasswordHash = oldHash);
        _userRepo.Setup(r => r.GetByEmailAsync(ValidEmail)).ReturnsAsync(user);

        var result = await NewService().LoginAsync(ValidEmail, ValidPassword);

        result.Should().NotBeNull();
        // BCrypt encodes cost as the 3rd "$"-segment: "$2a$NN$..."
        var costSegment = user.PasswordHash!.Split('$')[2];
        costSegment.Should().Be("12", "rehashed at the current target cost");
        // The new hash still verifies the original password.
        BCrypt.Net.BCrypt.Verify(ValidPassword, user.PasswordHash).Should().BeTrue();
        _userRepo.Verify(r => r.UpdateAsync(It.IsAny<User>()), Times.AtLeastOnce, "wrote upgraded hash");
    }

    [Fact]
    public async Task LoginAsync_does_not_rewrite_hash_when_work_factor_already_matches_target()
    {
        // Hash already at cost 12 → no extra write. Just one UpdateAsync at
        // most (the FailedLoginAttempts reset is skipped when counter is 0).
        var user = UserWith(ValidPassword); // helper uses cost 12
        user.FailedLoginAttempts = 0;
        user.LockedUntil = null;
        _userRepo.Setup(r => r.GetByEmailAsync(ValidEmail)).ReturnsAsync(user);

        await NewService().LoginAsync(ValidEmail, ValidPassword);

        _userRepo.Verify(r => r.UpdateAsync(It.IsAny<User>()), Times.Never,
            "no counter reset needed, no rehash needed");
    }

    // ──────────────────────────────────────────────────────────────────
    // VerifyEmailByTokenAsync
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task VerifyEmailByTokenAsync_fails_for_unknown_token()
    {
        _userRepo
            .Setup(r => r.GetByVerificationTokenLookupAsync(It.IsAny<string>()))
            .ReturnsAsync((User?)null);

        var (success, message) = await NewService().VerifyEmailByTokenAsync("nonexistent-token");

        success.Should().BeFalse();
        message.Should().Contain("Invalid");
    }

    [Fact]
    public async Task VerifyEmailByTokenAsync_succeeds_and_marks_user_verified_on_valid_token()
    {
        var token = "fresh-verification-token-xyz";
        var tokenHash = BCrypt.Net.BCrypt.HashPassword(token);
        var user = new User
        {
            Id = "u",
            Email = ValidEmail,
            DisplayName = "Alice",
            IsEmailVerified = false,
            EmailVerificationToken = tokenHash,
            EmailVerificationTokenExpiry = DateTime.UtcNow.AddHours(12),
        };
        _userRepo.Setup(r => r.GetByVerificationTokenLookupAsync(It.IsAny<string>())).ReturnsAsync(user);

        var (success, _) = await NewService().VerifyEmailByTokenAsync(token);

        success.Should().BeTrue();
        user.IsEmailVerified.Should().BeTrue();
        user.EmailVerificationToken.Should().BeNull("cleared so the unique index frees up");
        user.EmailVerificationTokenLookup.Should().BeNull();
        user.EmailVerificationTokenExpiry.Should().BeNull();
        _userRepo.Verify(r => r.UpdateAsync(user), Times.Once);
        _emailService.Verify(
            e => e.SendWelcomeEmailAsync(ValidEmail, "Alice"),
            Times.Once,
            "welcome email sent on first verify");
    }

    [Fact]
    public async Task VerifyEmailByTokenAsync_treats_already_verified_user_as_success_idempotently()
    {
        // Stale link click — user already verified through another tab.
        // Should still report success so the UI shows a friendly state.
        var token = "any-token";
        var tokenHash = BCrypt.Net.BCrypt.HashPassword(token);
        var user = new User
        {
            Id = "u",
            Email = ValidEmail,
            DisplayName = "Alice",
            IsEmailVerified = true,
            EmailVerificationToken = tokenHash,
            EmailVerificationTokenExpiry = DateTime.UtcNow.AddHours(12),
        };
        _userRepo.Setup(r => r.GetByVerificationTokenLookupAsync(It.IsAny<string>())).ReturnsAsync(user);

        var (success, message) = await NewService().VerifyEmailByTokenAsync(token);

        success.Should().BeTrue();
        message.Should().Contain("already verified");
    }

    [Fact]
    public async Task VerifyEmailByTokenAsync_fails_for_expired_token()
    {
        var token = "ancient-token";
        var tokenHash = BCrypt.Net.BCrypt.HashPassword(token);
        var user = new User
        {
            Id = "u",
            Email = ValidEmail,
            DisplayName = "Alice",
            IsEmailVerified = false,
            EmailVerificationToken = tokenHash,
            EmailVerificationTokenExpiry = DateTime.UtcNow.AddHours(-1),
        };
        _userRepo.Setup(r => r.GetByVerificationTokenLookupAsync(It.IsAny<string>())).ReturnsAsync(user);

        var (success, message) = await NewService().VerifyEmailByTokenAsync(token);

        success.Should().BeFalse();
        message.Should().Contain("expired");
        // Did NOT write — the bad path shouldn't burn through the unique
        // lookup or send the welcome email.
        _userRepo.Verify(r => r.UpdateAsync(It.IsAny<User>()), Times.Never);
        _emailService.Verify(e => e.SendWelcomeEmailAsync(It.IsAny<string>(), It.IsAny<string>()), Times.Never);
    }

    // ──────────────────────────────────────────────────────────────────
    // AcceptTermsAsync
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task AcceptTermsAsync_fails_when_user_not_found()
    {
        _userRepo.Setup(r => r.GetByIdAsync("missing")).ReturnsAsync((User?)null);

        var (success, message) = await NewService().AcceptTermsAsync("missing", "v1");

        success.Should().BeFalse();
        message.Should().Contain("not found");
    }

    [Fact]
    public async Task AcceptTermsAsync_stamps_user_with_version_and_timestamp()
    {
        var user = new User { Id = "u", Email = ValidEmail, DisplayName = "Alice" };
        _userRepo.Setup(r => r.GetByIdAsync("u")).ReturnsAsync(user);

        var before = DateTime.UtcNow;
        var (success, _) = await NewService().AcceptTermsAsync("u", "v2");
        var after = DateTime.UtcNow;

        success.Should().BeTrue();
        user.TermsVersion.Should().Be("v2");
        user.AcceptedTermsAt.Should().NotBeNull();
        user.AcceptedTermsAt!.Value.Should().BeOnOrAfter(before).And.BeOnOrBefore(after);
        _userRepo.Verify(r => r.UpdateAsync(user), Times.Once);
    }

    // ──────────────────────────────────────────────────────────────────
    // ValidateInvitationTokenAsync
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task ValidateInvitationTokenAsync_returns_invalid_for_unknown_token()
    {
        _invRepo
            .Setup(r => r.GetByTokenLookupAsync(It.IsAny<string>()))
            .ReturnsAsync((Invitation?)null);

        var result = await NewService().ValidateInvitationTokenAsync("nonexistent");

        result.IsValid.Should().BeFalse();
        result.Message.Should().Contain("Invalid");
    }

    [Fact]
    public async Task ValidateInvitationTokenAsync_returns_invalid_for_used_invitation()
    {
        var token = "real-token";
        var invitation = new Invitation
        {
            Id = "inv-1",
            InviterUserId = "inviter",
            InviteeEmail = "friend@example.test",
            InvitationToken = BCrypt.Net.BCrypt.HashPassword(token),
            Status = InvitationStatus.Used,
            ExpiresAt = DateTime.UtcNow.AddDays(7),
        };
        _invRepo
            .Setup(r => r.GetByTokenLookupAsync(It.IsAny<string>()))
            .ReturnsAsync(invitation);

        var result = await NewService().ValidateInvitationTokenAsync(token);

        result.IsValid.Should().BeFalse();
        result.Message.Should().Contain("already been used");
    }

    [Fact]
    public async Task ValidateInvitationTokenAsync_returns_invalid_for_expired_invitation()
    {
        var token = "real-token";
        var invitation = new Invitation
        {
            Id = "inv-1",
            InviterUserId = "inviter",
            InviteeEmail = "friend@example.test",
            InvitationToken = BCrypt.Net.BCrypt.HashPassword(token),
            Status = InvitationStatus.Pending,
            ExpiresAt = DateTime.UtcNow.AddDays(-1),
        };
        _invRepo
            .Setup(r => r.GetByTokenLookupAsync(It.IsAny<string>()))
            .ReturnsAsync(invitation);

        var result = await NewService().ValidateInvitationTokenAsync(token);

        result.IsValid.Should().BeFalse();
        result.Message.Should().Contain("expired");
    }

    [Fact]
    public async Task ValidateInvitationTokenAsync_returns_valid_with_inviter_name_for_pending_invitation()
    {
        var token = "real-token";
        var invitation = new Invitation
        {
            Id = "inv-1",
            InviterUserId = "inviter",
            InviteeEmail = "friend@example.test",
            InvitationToken = BCrypt.Net.BCrypt.HashPassword(token),
            Status = InvitationStatus.Pending,
            ExpiresAt = DateTime.UtcNow.AddDays(7),
        };
        _invRepo
            .Setup(r => r.GetByTokenLookupAsync(It.IsAny<string>()))
            .ReturnsAsync(invitation);
        _userRepo
            .Setup(r => r.GetByIdAsync("inviter"))
            .ReturnsAsync(new User { Id = "inviter", Email = "host@example.test", DisplayName = "Bob" });

        var result = await NewService().ValidateInvitationTokenAsync(token);

        result.IsValid.Should().BeTrue();
        result.InviterName.Should().Be("Bob");
    }

    // ──────────────────────────────────────────────────────────────────
    // First-run setup — IsSetupCompleteAsync + CreateRootUserAsync
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task IsSetupCompleteAsync_delegates_to_repository_any_user_check()
    {
        // Trivial pass-through, but the contract matters: setup status is a
        // single bit reflecting "does any user exist", not a derived predicate.
        _userRepo.Setup(r => r.AnyUserExistsAsync()).ReturnsAsync(true);
        (await NewService().IsSetupCompleteAsync()).Should().BeTrue();

        _userRepo.Setup(r => r.AnyUserExistsAsync()).ReturnsAsync(false);
        (await NewService().IsSetupCompleteAsync()).Should().BeFalse();
    }

    [Fact]
    public async Task CreateRootUserAsync_creates_email_verified_root_when_db_is_empty()
    {
        // Happy path: no users → setup is open → first user lands as root.
        _userRepo.Setup(r => r.AnyUserExistsAsync()).ReturnsAsync(false);

        User? created = null;
        _userRepo
            .Setup(r => r.CreateAsync(It.IsAny<User>()))
            .Callback<User>(u =>
            {
                // The real Mongo repo assigns _id on insert. The downstream
                // JWT issue path reads user.Id into a Claim, which throws on
                // null. Simulate the Mongo side effect so the in-process
                // pipeline can complete end-to-end in tests.
                u.Id = "507f1f77bcf86cd799439011";
                created = u;
            })
            .ReturnsAsync((User u) => u);

        var (success, _, response) = await NewService().CreateRootUserAsync(
            "ROOT@example.test", "Root Admin", ValidPassword);

        success.Should().BeTrue();
        response.Should().NotBeNull();
        response!.Token.Should().NotBeNullOrEmpty("setup hands back an immediately-usable login");
        response.IsRootUser.Should().BeTrue();

        created.Should().NotBeNull();
        created!.Email.Should().Be("root@example.test", "email is normalized to lowercase");
        created.DisplayName.Should().Be("Root Admin");
        created.IsRootUser.Should().BeTrue("the FIRST user IS the admin by definition");
        created.IsEmailVerified.Should().BeTrue("no magic-link round-trip on the first user");
        created.PasswordHash.Should().NotBeNullOrEmpty();
        BCrypt.Net.BCrypt.Verify(ValidPassword, created.PasswordHash).Should().BeTrue();
    }

    [Fact]
    public async Task CreateRootUserAsync_refuses_when_any_user_already_exists()
    {
        // Sealed-after-first-use invariant. Includes soft-deleted users — the
        // repository's AnyUserExistsAsync doesn't filter IsDeleted because the
        // unique-email index would block the re-insert anyway.
        _userRepo.Setup(r => r.AnyUserExistsAsync()).ReturnsAsync(true);

        var (success, message, response) = await NewService().CreateRootUserAsync(
            "root@example.test", "Root", ValidPassword);

        success.Should().BeFalse();
        response.Should().BeNull();
        message.Should().Contain("already complete");
        // No write attempted — keeps the audit log clean.
        _userRepo.Verify(r => r.CreateAsync(It.IsAny<User>()), Times.Never);
    }

    [Fact]
    public async Task CreateRootUserAsync_rejects_weak_password()
    {
        _userRepo.Setup(r => r.AnyUserExistsAsync()).ReturnsAsync(false);

        var (success, _, response) = await NewService().CreateRootUserAsync(
            "root@example.test", "Root", "short");

        success.Should().BeFalse();
        response.Should().BeNull();
        _userRepo.Verify(r => r.CreateAsync(It.IsAny<User>()), Times.Never,
            "rejected at validator, never reaches the DB");
    }

    [Fact]
    public async Task CreateRootUserAsync_rejects_empty_email_or_displayName()
    {
        _userRepo.Setup(r => r.AnyUserExistsAsync()).ReturnsAsync(false);

        var emptyEmail = await NewService().CreateRootUserAsync("  ", "Root", ValidPassword);
        emptyEmail.Success.Should().BeFalse();
        emptyEmail.Message.Should().Contain("Email");

        var emptyName = await NewService().CreateRootUserAsync("root@example.test", "  ", ValidPassword);
        emptyName.Success.Should().BeFalse();
        emptyName.Message.Should().Contain("name");

        _userRepo.Verify(r => r.CreateAsync(It.IsAny<User>()), Times.Never);
    }

    [Fact]
    public async Task ValidateInvitationTokenAsync_returns_invalid_when_tokenLookup_matches_but_hash_does_not()
    {
        // Defense-in-depth check called out in the production comment: if a
        // DB writer tampers with TokenLookup to redirect to a different row,
        // the BCrypt-verify step still rejects.
        var realToken = "real-token";
        var differentToken = "different-token";
        var invitation = new Invitation
        {
            Id = "inv-1",
            InviterUserId = "inviter",
            InviteeEmail = "friend@example.test",
            InvitationToken = BCrypt.Net.BCrypt.HashPassword(realToken),
            Status = InvitationStatus.Pending,
            ExpiresAt = DateTime.UtcNow.AddDays(7),
        };
        _invRepo
            .Setup(r => r.GetByTokenLookupAsync(It.IsAny<string>()))
            .ReturnsAsync(invitation);

        // Caller supplies a different token whose lookup happens to point
        // to the same row (e.g., tampered DB).
        var result = await NewService().ValidateInvitationTokenAsync(differentToken);

        result.IsValid.Should().BeFalse();
    }
}

using System.IdentityModel.Tokens.Jwt;
using System.Net.Http;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Google.Apis.Auth;
using Microsoft.Extensions.Configuration;
using Microsoft.IdentityModel.Tokens;
using MongoDB.Driver;
using WatchTogether.Business.DTOs;
using WatchTogether.Business.Validators;
using WatchTogether.Data.Entities;
using WatchTogether.Data.Repositories;

namespace WatchTogether.Business.Services;

public class AuthService : IAuthService
{
    private readonly IUserRepository _userRepository;
    private readonly IInvitationRepository _invitationRepository;
    private readonly IInvitationLinkService _invitationLinkService;
    private readonly IInvitationService _invitationService;
    private readonly IEmailService _emailService;
    private readonly IConfiguration _configuration;
    private readonly IHttpClientFactory _httpClientFactory;

    public AuthService(
        IUserRepository userRepository,
        IInvitationRepository invitationRepository,
        IInvitationLinkService invitationLinkService,
        IInvitationService invitationService,
        IEmailService emailService,
        IConfiguration configuration,
        IHttpClientFactory httpClientFactory)
    {
        _userRepository = userRepository;
        _invitationRepository = invitationRepository;
        _invitationLinkService = invitationLinkService;
        _invitationService = invitationService;
        _emailService = emailService;
        _configuration = configuration;
        _httpClientFactory = httpClientFactory;
    }

    #region Login

    /// <summary>
    /// BCrypt work factor for newly hashed passwords. OWASP 2026 recommends ≥12;
    /// at this cost a single Verify is ~400ms on a modest CPU. Bumping later is
    /// safe — existing hashes carry their original cost embedded in the string
    /// and continue to verify correctly; only the rehash-on-login path below
    /// upgrades them gradually.
    /// </summary>
    private const int BCryptWorkFactor = 12;

    /// <summary>
    /// Generated once per process at the current work factor. Used as a target
    /// for BCrypt.Verify in the user-not-found branch of LoginAsync so the
    /// response time is constant regardless of whether the email exists.
    /// Without this, a not-found response returns ~400ms faster than a
    /// wrong-password response, enough signal to enumerate registered emails.
    /// </summary>
    private static readonly string _dummyBcryptHash =
        BCrypt.Net.BCrypt.HashPassword(Guid.NewGuid().ToString(), BCrypt.Net.BCrypt.GenerateSalt(BCryptWorkFactor));

    public async Task<ExtendedLoginResponse?> LoginAsync(string email, string password)
    {
        var user = await _userRepository.GetByEmailAsync(email);
        if (user == null)
        {
            // Burn ~400ms (same cost factor as real password hashes) so an
            // attacker can't distinguish "user doesn't exist" from "user exists
            // but wrong password" by response timing. The Verify result is
            // discarded — we always return null on this branch.
            _ = BCrypt.Net.BCrypt.Verify(password, _dummyBcryptHash);
            return null;
        }

        // Per-account lockout: a distributed attack can route around the
        // IP-based 5/min rate limit in Program.cs by rotating IPs against the
        // same email. The counter on User.FailedLoginAttempts uses exponential
        // backoff (locked period doubles each failed attempt past threshold).
        if (user.LockedUntil.HasValue && user.LockedUntil.Value > DateTime.UtcNow)
        {
            // Still locked. Run dummy verify to keep response timing constant
            // (so we don't leak "this account is locked" by timing).
            _ = BCrypt.Net.BCrypt.Verify(password, _dummyBcryptHash);
            return null;
        }

        // Verify password. Google-only users have no PasswordHash — they
        // can only sign in via /api/auth/google. Treat the password-login
        // attempt as a generic failure (don't disclose "this account uses
        // Google" to the caller).
        if (string.IsNullOrEmpty(user.PasswordHash))
        {
            _ = BCrypt.Net.BCrypt.Verify(password, _dummyBcryptHash);
            await RegisterFailedLoginAsync(user);
            return null;
        }
        if (!BCrypt.Net.BCrypt.Verify(password, user.PasswordHash))
        {
            await RegisterFailedLoginAsync(user);
            return null;
        }

        // Successful login — reset the lockout counter (only if it was non-zero,
        // to avoid an extra write on every login).
        if (user.FailedLoginAttempts != 0 || user.LockedUntil != null)
        {
            user.FailedLoginAttempts = 0;
            user.LockedUntil = null;
            await _userRepository.UpdateAsync(user);
        }

        // Rehash-on-login: if the stored hash was generated at a lower work
        // factor than our current target, upgrade it now while we have the
        // plaintext in memory. The user pays one extra ~400ms BCrypt op on
        // this single login; every subsequent login uses the stronger hash.
        // (PasswordHash is non-null at this point — the IsNullOrEmpty check
        // above already short-circuited for Google-only users.)
        if (!string.IsNullOrEmpty(user.PasswordHash) && NeedsRehash(user.PasswordHash))
        {
            user.PasswordHash = BCrypt.Net.BCrypt.HashPassword(password, BCrypt.Net.BCrypt.GenerateSalt(BCryptWorkFactor));
            await _userRepository.UpdateAsync(user);
        }

        // Check email verification (except for root user who is pre-verified)
        if (!user.IsEmailVerified && !user.IsRootUser)
            return null;

        var token = GenerateJwtToken(user);
        var slots = await _invitationService.GetAvailableSlotsAsync(user.Id);

        return new ExtendedLoginResponse
        {
            Token = token,
            DisplayName = user.DisplayName,
            Email = user.Email,
            IsRootUser = user.IsRootUser,
            IsInvitationTicketUsed = slots.RemainingSlots <= 0,
            HasAcceptedTerms = user.AcceptedTermsAt.HasValue
        };
    }

    /// <summary>
    /// Google Sign-In flow. The frontend uses Google Identity Services to get
    /// an ID token (JWT signed by Google), then POSTs it here. We:
    ///
    ///   1. Validate the token's signature, issuer, expiry, and audience
    ///      against Google:ClientId. If any of these fail, return null —
    ///      the caller maps this to 401.
    ///   2. Resolve the user:
    ///        - GoogleId match → existing Google user, just log them in.
    ///        - Email match → existing local account, link the GoogleId
    ///          (one-time merge so future Google sign-ins find them by
    ///          GoogleId directly). Also mark email-verified — Google
    ///          confirmed the address so the local "verify your email"
    ///          step becomes redundant.
    ///        - Neither → brand-new user. Open-registration policy: no
    ///          invitation required, no password set. Email auto-verified.
    ///   3. Issue the same JWT the password-login path returns. Caller
    ///      sets the HttpOnly cookie.
    ///
    /// Lockout / FailedLoginAttempts don't apply to this path — token
    /// validation is the gate, and a forged token never reaches step 2.
    /// </summary>
    public async Task<ExtendedLoginResponse?> GoogleSignInAsync(string idToken, string? invitationLinkToken = null)
    {
        var clientId = _configuration["Google:ClientId"];
        if (string.IsNullOrEmpty(clientId))
        {
            // Config missing — refuse rather than silently accept any token.
            // This is what stops a misconfigured deployment from accepting
            // tokens issued to a *different* app's Google client.
            return null;
        }

        GoogleJsonWebSignature.Payload payload;
        try
        {
            var settings = new GoogleJsonWebSignature.ValidationSettings
            {
                Audience = new[] { clientId },
            };
            payload = await GoogleJsonWebSignature.ValidateAsync(idToken, settings);
        }
        catch (InvalidJwtException)
        {
            // Signature / expiry / audience mismatch — anything that means
            // "we cannot trust this token." Don't leak which one to the
            // caller; just refuse.
            return null;
        }

        // Google says the email isn't verified at their end — refuse so we
        // never create an account on an unverified Google identity. (In
        // practice this is rare; Google almost always returns true.)
        if (!payload.EmailVerified)
        {
            return null;
        }

        var googleId = payload.Subject;
        var email = (payload.Email ?? string.Empty).ToLowerInvariant().Trim();
        if (string.IsNullOrEmpty(googleId) || string.IsNullOrEmpty(email))
        {
            return null;
        }
        var displayName = !string.IsNullOrWhiteSpace(payload.Name)
            ? payload.Name
            : email.Split('@')[0];

        // Step 2a: returning Google user.
        var user = await _userRepository.GetByGoogleIdAsync(googleId);

        // Step 2b: existing local account — link.
        if (user == null)
        {
            user = await _userRepository.GetByEmailAsync(email);
            if (user != null)
            {
                user.GoogleId = googleId;
                if (!user.IsEmailVerified) user.IsEmailVerified = true;
                await _userRepository.UpdateAsync(user);
            }
        }

        // Step 2c: brand new user — invitation-gated.
        if (user == null)
        {
            // Closed-invite model: a fresh Google identity (no GoogleId match,
            // no email match) must arrive carrying a valid, unused invitation
            // link or we refuse. This matches the password registration flow
            // — invites are the gate, not Google's verified-email signal.
            if (string.IsNullOrWhiteSpace(invitationLinkToken))
            {
                return null;
            }

            var linkValidation = await _invitationLinkService.ValidateLinkAsync(invitationLinkToken);
            if (!linkValidation.Valid)
            {
                return null;
            }

            user = new User
            {
                Email = email,
                DisplayName = displayName,
                GoogleId = googleId,
                InvitedByUserId = linkValidation.InviterUserId,
                IsEmailVerified = true,
                CreatedAt = DateTime.UtcNow,
                // No PasswordHash — pure Google account until they choose
                // to set one via a future "add a backup password" flow.
            };

            try
            {
                user = await _userRepository.CreateAsync(user);
            }
            catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                // Concurrent registration with the same email — give up rather
                // than re-resolve. The caller can retry; on retry, the now-
                // existing account will match in Step 2a or 2b.
                return null;
            }

            // Burn the invitation link now that the account exists.
            if (linkValidation.InvitationLinkId != null)
            {
                await _invitationLinkService.MarkLinkUsedAsync(linkValidation.InvitationLinkId, user.Id);
            }
        }

        var token = GenerateJwtToken(user);
        var slots = await _invitationService.GetAvailableSlotsAsync(user.Id);

        return new ExtendedLoginResponse
        {
            Token = token,
            DisplayName = user.DisplayName,
            Email = user.Email,
            IsRootUser = user.IsRootUser,
            IsInvitationTicketUsed = slots.RemainingSlots <= 0,
            HasAcceptedTerms = user.AcceptedTermsAt.HasValue
        };
    }

    public async Task<ExtendedLoginResponse> IssueLoginResponseAsync(User user)
    {
        var token = GenerateJwtToken(user);
        var slots = await _invitationService.GetAvailableSlotsAsync(user.Id);
        return new ExtendedLoginResponse
        {
            Token = token,
            DisplayName = user.DisplayName,
            Email = user.Email,
            IsRootUser = user.IsRootUser,
            IsInvitationTicketUsed = slots.RemainingSlots <= 0,
            HasAcceptedTerms = user.AcceptedTermsAt.HasValue,
        };
    }

    public async Task<MeResponse?> GetCurrentUserAsync(string userId)
    {
        var user = await _userRepository.GetByIdAsync(userId);
        if (user == null) return null;

        var slots = await _invitationService.GetAvailableSlotsAsync(user.Id);

        return new MeResponse
        {
            Email = user.Email,
            DisplayName = user.DisplayName,
            IsRootUser = user.IsRootUser,
            IsInvitationTicketUsed = slots.RemainingSlots <= 0,
            HasAcceptedTerms = user.AcceptedTermsAt.HasValue
        };
    }

    #endregion

    #region Registration

    public async Task<ValidateInvitationResponse> ValidateInvitationTokenAsync(string token)
    {
        // Same fast-lookup pattern as InvitationLinkService.ValidateLinkAsync.
        // SHA-256(token) → indexed point query, then BCrypt-verify the BCrypt
        // hash against the supplied plaintext. Closes both the O(n) scan path
        // and the plaintext-at-rest leak.
        var tokenLookup = ComputeInvitationTokenLookup(token);
        var invitation = await _invitationRepository.GetByTokenLookupAsync(tokenLookup);

        // Defense in depth: also verify the BCrypt hash, so a tampered TokenLookup
        // (insider with DB write) doesn't redirect to a different invitation.
        if (invitation != null && !BCrypt.Net.BCrypt.Verify(token, invitation.InvitationToken))
        {
            invitation = null;
        }

        if (invitation == null)
        {
            return new ValidateInvitationResponse
            {
                IsValid = false,
                Message = "Invalid invitation link"
            };
        }

        if (invitation.Status != InvitationStatus.Pending)
        {
            return new ValidateInvitationResponse
            {
                IsValid = false,
                Message = invitation.Status == InvitationStatus.Used
                    ? "This invitation has already been used"
                    : "This invitation is no longer valid"
            };
        }

        if (invitation.ExpiresAt < DateTime.UtcNow)
        {
            return new ValidateInvitationResponse
            {
                IsValid = false,
                Message = "This invitation has expired"
            };
        }

        // Get inviter name
        var inviter = await _userRepository.GetByIdAsync(invitation.InviterUserId);

        return new ValidateInvitationResponse
        {
            IsValid = true,
            InviterName = inviter?.DisplayName ?? "Someone"
            // InviteeEmail intentionally omitted — see DTO comment for rationale.
        };
    }

    public async Task<(bool Success, string Message, string? Email)> RegisterAsync(
        string invitationToken, string displayName, string password)
    {
        // Validate invitation via fast lookup + BCrypt verify (same pattern as
        // ValidateInvitationTokenAsync). The legacy plaintext-token query path
        // was retired in the final-tidy batch.
        var invitationTokenLookup = ComputeInvitationTokenLookup(invitationToken);
        var invitation = await _invitationRepository.GetByTokenLookupAsync(invitationTokenLookup);
        if (invitation != null && !BCrypt.Net.BCrypt.Verify(invitationToken, invitation.InvitationToken))
        {
            invitation = null;
        }
        if (invitation == null || invitation.Status != InvitationStatus.Pending)
        {
            return (false, "Invalid or expired invitation", null);
        }

        if (invitation.ExpiresAt < DateTime.UtcNow)
        {
            return (false, "This invitation has expired", null);
        }

        // Check if email already exists
        if (await _userRepository.ExistsAsync(invitation.InviteeEmail))
        {
            return (false, "An account with this email already exists", null);
        }

        // Validate password
        var (isValid, errors) = PasswordValidator.Validate(password);
        if (!isValid)
        {
            return (false, string.Join(", ", errors), null);
        }

        // HIBP breach check — k-anonymity, so the plaintext password never
        // leaves the server. Network failure fails open (the sync rules
        // already gave us a strong baseline). Adds ~50-200ms to registration.
        if (await PasswordValidator.IsPwnedAsync(password, _httpClientFactory.CreateClient()))
        {
            return (false, "This password has appeared in known data breaches. Please choose a different one.", null);
        }

        // Create user. Invite-based registration is auto-verified: the inviter
        // already vetted this person off-band (they sent them the link via DM /
        // WhatsApp / etc.), so a verification email round-trip just creates a
        // failure mode where junk-mailed invites leave invitees stranded. The
        // closed-invite system is the spam gate; email confirmation is redundant.
        var user = new User
        {
            // ToLowerInvariant — keep the stored email aligned with what every
            // other path queries with (see UserRepository.GetByEmailAsync). On a
            // tr-TR-locale server, plain ToLower would lower "I" → "ı" and split
            // the unique index between mojibake and ASCII rows.
            Email = invitation.InviteeEmail.ToLowerInvariant().Trim(),
            DisplayName = displayName.Trim(),
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(password, BCrypt.Net.BCrypt.GenerateSalt(BCryptWorkFactor)),
            InvitedByUserId = invitation.InviterUserId,
            IsEmailVerified = true,
            CreatedAt = DateTime.UtcNow
        };

        // The unique index on users.email is the final guard against the TOCTOU race
        // between ExistsAsync above and CreateAsync here. Catch the duplicate-key error
        // and return the same friendly message — appears identical to the user.
        try
        {
            await _userRepository.CreateAsync(user);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            return (false, "An account with this email already exists", null);
        }

        // Finalize the invitation immediately — no email-delivery gate any more,
        // so the burn-and-rollback dance is gone too. Best-effort: see the
        // matching block in RegisterWithLinkAsync for the rationale (user is
        // already created; a 500 here would trap the friend in a retry-loop
        // against "already exists").
        invitation.Status = InvitationStatus.Used;
        invitation.UsedAt = DateTime.UtcNow;
        invitation.RegisteredUserId = user.Id;
        try
        {
            await _invitationRepository.UpdateAsync(invitation);
        }
        catch { /* invitation status update failed; user already exists, invitation expires via TTL */ }

        // Welcome email is best-effort — if Resend is misconfigured or down the
        // user still has a working account. We swallow failures rather than
        // rolling back like the old verification flow did.
        try
        {
            await _emailService.SendWelcomeEmailAsync(user.Email, user.DisplayName);
        }
        catch { /* welcome email failed; user creation already succeeded — keep going */ }

        return (true, "Registration successful. You can now sign in.", user.Email);
    }

    /// <summary>
    /// Register a new user using a shareable invitation link.
    /// Unlike the email-based registration, the user provides their own email address.
    /// </summary>
    public async Task<(bool Success, string Message, string? Email)> RegisterWithLinkAsync(
        string linkToken, string email, string displayName, string password)
    {
        // Validate the invitation link
        var linkValidation = await _invitationLinkService.ValidateLinkAsync(linkToken);
        if (!linkValidation.Valid)
        {
            return (false, linkValidation.Message ?? "Invalid invitation link", null);
        }

        // Normalize email. ToLowerInvariant (not ToLower) so a tr-TR-locale
        // server can't lower "I" → "ı" and cause the stored value to drift from
        // what later ExistsAsync calls query with. Keep all email normalization
        // in this codebase invariant for the same reason.
        var normalizedEmail = email.ToLowerInvariant().Trim();

        // Check if email already exists
        if (await _userRepository.ExistsAsync(normalizedEmail))
        {
            return (false, "An account with this email already exists", null);
        }

        // Validate password
        var (isValid, errors) = PasswordValidator.Validate(password);
        if (!isValid)
        {
            return (false, string.Join(", ", errors), null);
        }

        // HIBP breach check — k-anonymity, so the plaintext password never
        // leaves the server. Network failure fails open (the sync rules
        // already gave us a strong baseline). Adds ~50-200ms to registration.
        if (await PasswordValidator.IsPwnedAsync(password, _httpClientFactory.CreateClient()))
        {
            return (false, "This password has appeared in known data breaches. Please choose a different one.", null);
        }

        // Create user — auto-verified, same rationale as RegisterAsync. The inviter
        // shared this link off-band, the link itself acts as the gate. Email is just
        // a name on the account, not a thing-to-prove.
        var user = new User
        {
            Email = normalizedEmail,
            DisplayName = displayName.Trim(),
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(password, BCrypt.Net.BCrypt.GenerateSalt(BCryptWorkFactor)),
            InvitedByUserId = linkValidation.InviterUserId,
            IsEmailVerified = true,
            CreatedAt = DateTime.UtcNow
        };

        // Unique-index race guard (see RegisterAsync above for the same pattern).
        try
        {
            await _userRepository.CreateAsync(user);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            return (false, "An account with this email already exists", null);
        }

        // Burn the invitation link now that the account exists. Best-effort
        // because the user IS already created — if MarkLinkUsedAsync throws (DB
        // hiccup, network drop), bubbling the exception would return 500 to the
        // friend, who would then retry with the same email and hit "already
        // exists" forever. The link becomes "stale-pending" until the TTL
        // sweep, which is harmless — the user creation already consumed the
        // intent, and the next ValidateLinkAsync will still flag the link as
        // valid only until it expires naturally.
        if (linkValidation.InvitationLinkId != null)
        {
            try
            {
                await _invitationLinkService.MarkLinkUsedAsync(linkValidation.InvitationLinkId, user.Id);
            }
            catch { /* link burn failed; user already exists, link expires via TTL */ }
        }

        // Welcome email is best-effort — never blocks the registration response.
        try
        {
            await _emailService.SendWelcomeEmailAsync(user.Email, user.DisplayName);
        }
        catch { /* welcome email failed; account already exists — keep going */ }

        return (true, "Registration successful. You can now sign in.", user.Email);
    }

    #endregion

    #region Email Verification

    public async Task<(bool Success, string Message)> VerifyEmailByTokenAsync(string token)
    {
        // Fast path: SHA-256(token) → indexed point query. Replaces the previous
        // "fetch every unverified user and BCrypt-verify against each" loop, which
        // was an O(n) BCrypt amplifier on a rate-limited but anonymous endpoint.
        var tokenLookup = ComputeVerificationTokenLookup(token);
        var user = await _userRepository.GetByVerificationTokenLookupAsync(tokenLookup);

        // Defense in depth: BCrypt-verify the matched row. Catches DB tampering and
        // hypothetical SHA-256 collisions.
        if (user == null ||
            string.IsNullOrEmpty(user.EmailVerificationToken) ||
            !BCrypt.Net.BCrypt.Verify(token, user.EmailVerificationToken))
        {
            return (false, "Invalid verification link");
        }

        if (user.IsEmailVerified)
        {
            return (true, "Email is already verified");
        }

        if (user.EmailVerificationTokenExpiry < DateTime.UtcNow)
        {
            return (false, "Verification link has expired. Please request a new one.");
        }

        // Mark as verified — also clear the lookup field so the unique index doesn't
        // block a later password-reset token (and so the row stops being indexable
        // through this lookup at all).
        user.IsEmailVerified = true;
        user.EmailVerificationToken = null;
        user.EmailVerificationTokenLookup = null;
        user.EmailVerificationTokenExpiry = null;
        await _userRepository.UpdateAsync(user);

        // Send welcome email
        await _emailService.SendWelcomeEmailAsync(user.Email, user.DisplayName);

        return (true, "Email verified successfully. You can now log in.");
    }

    public async Task<(bool Success, string Message)> ResendVerificationEmailAsync(string email)
    {
        var user = await _userRepository.GetByEmailAsync(email);
        if (user == null)
        {
            return (false, "User not found");
        }

        if (user.IsEmailVerified)
        {
            return (false, "Email is already verified");
        }

        // Generate new verification token and hash it
        var verificationToken = GenerateVerificationToken();
        var tokenHash = BCrypt.Net.BCrypt.HashPassword(verificationToken);
        var tokenLookup = ComputeVerificationTokenLookup(verificationToken);
        var expiryHours = int.TryParse(_configuration["Email:VerificationTokenExpiryHours"], out var parsedExpiryHours) ? parsedExpiryHours : 24;

        user.EmailVerificationToken = tokenHash;
        user.EmailVerificationTokenLookup = tokenLookup;
        user.EmailVerificationTokenExpiry = DateTime.UtcNow.AddHours(expiryHours);
        await _userRepository.UpdateAsync(user);

        // Build verification URL
        var frontendUrl = _configuration["App:FrontendUrl"] ?? "http://localhost:5173";
        var verificationUrl = $"{frontendUrl}/verify-email/{verificationToken}";

        // Send verification email with magic link
        await _emailService.SendVerificationEmailAsync(user.Email, user.DisplayName, verificationUrl);

        return (true, "Verification email sent");
    }

    #endregion

    #region Terms

    public async Task<(bool Success, string Message)> AcceptTermsAsync(string userId, string version)
    {
        var user = await _userRepository.GetByIdAsync(userId);
        if (user == null)
        {
            return (false, "User not found");
        }

        user.AcceptedTermsAt = DateTime.UtcNow;
        user.TermsVersion = version;
        await _userRepository.UpdateAsync(user);

        return (true, "Terms accepted");
    }

    #endregion

    #region First-run setup

    /// <inheritdoc />
    public Task<bool> IsSetupCompleteAsync() => _userRepository.AnyUserExistsAsync();

    /// <inheritdoc />
    public async Task<(bool Success, string Message, ExtendedLoginResponse? Response)>
        CreateRootUserAsync(string email, string displayName, string password)
    {
        // Strict invariant: setup is one-shot. Once ANY user is in the DB
        // (active, soft-deleted, anonymized — doesn't matter) we refuse.
        // The check is duplicated by the unique-on-email index at the
        // storage layer, so a TOCTOU race between two concurrent setup
        // calls can't sneak through.
        if (await _userRepository.AnyUserExistsAsync())
        {
            return (false, "Setup is already complete. Use the normal sign-in flow.", null);
        }

        // Normalize email up-front — both for the index and so the response
        // matches what /login would return for the same address. ToLowerInvariant
        // for tr-TR safety (see other email normalization sites in this file).
        var normalizedEmail = email.ToLowerInvariant().Trim();
        if (string.IsNullOrWhiteSpace(normalizedEmail))
        {
            return (false, "Email is required.", null);
        }
        if (string.IsNullOrWhiteSpace(displayName))
        {
            return (false, "Display name is required.", null);
        }

        // Same password rules as RegisterAsync — root account shouldn't be
        // weaker than a regular invited account.
        var (isValid, errors) = Validators.PasswordValidator.Validate(password);
        if (!isValid)
        {
            return (false, string.Join(", ", errors), null);
        }

        // HIBP breach check (same as Register). Net failure fails open — we'd
        // rather complete setup than block on a transient API hiccup.
        if (await Validators.PasswordValidator.IsPwnedAsync(password, _httpClientFactory.CreateClient()))
        {
            return (false, "This password has appeared in known data breaches. Please choose a different one.", null);
        }

        var user = new User
        {
            Email = normalizedEmail,
            DisplayName = displayName.Trim(),
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(password, BCrypt.Net.BCrypt.GenerateSalt(BCryptWorkFactor)),
            // The first user IS the admin — no invitation chain, no
            // email-verification round-trip (nobody else exists to verify
            // for them). Both flags set up front.
            IsRootUser = true,
            IsEmailVerified = true,
            CreatedAt = DateTime.UtcNow,
        };

        try
        {
            await _userRepository.CreateAsync(user);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            // Shouldn't happen given the AnyUserExistsAsync guard above, but
            // a concurrent setup call could squeak in. The unique index is
            // the last word.
            return (false, "Setup is already complete. Use the normal sign-in flow.", null);
        }

        // Hand back the same response shape as a successful /login so the
        // caller can immediately set the auth cookie and the frontend can
        // proceed straight to the lobby.
        var response = await IssueLoginResponseAsync(user);
        return (true, "Root user created.", response);
    }

    #endregion

    #region Helpers

    private string GenerateJwtToken(User user)
    {
        var secret = _configuration["Jwt:Secret"]
            ?? throw new InvalidOperationException("JWT secret not configured");
        var issuer = _configuration["Jwt:Issuer"];
        var audience = _configuration["Jwt:Audience"];
        var expirationHours = int.TryParse(_configuration["Jwt:ExpirationHours"], out var parsedExpiration) ? parsedExpiration : 24;

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret));
        var credentials = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        var claims = new List<Claim>
        {
            new Claim(ClaimTypes.NameIdentifier, user.Id),
            new Claim(ClaimTypes.Email, user.Email),
            new Claim(ClaimTypes.Name, user.DisplayName),
            new Claim(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString())
        };

        // Add admin role for root user
        if (user.IsRootUser)
        {
            claims.Add(new Claim(ClaimTypes.Role, "Admin"));
        }

        var token = new JwtSecurityToken(
            issuer: issuer,
            audience: audience,
            claims: claims,
            expires: DateTime.UtcNow.AddHours(expirationHours),
            signingCredentials: credentials
        );

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private static string GenerateVerificationToken()
    {
        // Generate a cryptographically secure token (32 bytes = 256 bits)
        var bytes = new byte[32];
        RandomNumberGenerator.Fill(bytes);
        return Convert.ToBase64String(bytes).Replace("+", "-").Replace("/", "_").TrimEnd('=');
    }

    /// <summary>
    /// Deterministic SHA-256 (hex) of the verification token. Same pattern as
    /// InvitationLinkService.ComputeTokenLookup — turns the O(n) BCrypt scan over
    /// unverified users into an O(1) point query via the indexed lookup field.
    /// </summary>
    private static string ComputeVerificationTokenLookup(string token)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(token));
        return Convert.ToHexString(bytes);
    }

    /// <summary>
    /// Same shape as ComputeVerificationTokenLookup but for legacy email-based
    /// invitation tokens. Kept separate so a future cross-token reuse can't
    /// happen by mistake (a verification token would hash to the same value but
    /// would query a different collection).
    /// </summary>
    private static string ComputeInvitationTokenLookup(string token)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(token));
        return Convert.ToHexString(bytes);
    }

    /// <summary>
    /// Lockout policy for failed login attempts. After the threshold, lock
    /// for an exponentially growing window so a distributed credential-stuffing
    /// attack hits an effective rate limit per target email regardless of
    /// source IPs.
    ///   attempts 1-4: no lock (give the typo-prone user some grace)
    ///   attempt 5+:   lock for 2^(attempt-5) minutes, capped at 1 hour
    /// </summary>
    private const int LockoutThreshold = 5;
    private static readonly TimeSpan LockoutMaxDuration = TimeSpan.FromHours(1);

    private async Task RegisterFailedLoginAsync(Data.Entities.User user)
    {
        user.FailedLoginAttempts++;
        if (user.FailedLoginAttempts >= LockoutThreshold)
        {
            var overflow = user.FailedLoginAttempts - LockoutThreshold;
            // 1, 2, 4, 8, 16, 32 minutes... capped at 60.
            var minutes = Math.Min((int)LockoutMaxDuration.TotalMinutes, 1 << Math.Min(overflow, 6));
            user.LockedUntil = DateTime.UtcNow.AddMinutes(minutes);
        }
        await _userRepository.UpdateAsync(user);
    }

    /// <summary>
    /// Returns true if the stored BCrypt hash was generated at a work factor
    /// below our current target. BCrypt hashes embed the cost as a 2-digit
    /// segment in the format $2a$NN$... — we parse that directly rather than
    /// pull in a library helper.
    /// </summary>
    private static bool NeedsRehash(string storedHash)
    {
        // Expected format: "$2a$10$..." or "$2b$12$..." — the third field is cost.
        if (string.IsNullOrEmpty(storedHash) || storedHash.Length < 7) return false;
        var parts = storedHash.Split('$');
        if (parts.Length < 4) return false;
        return int.TryParse(parts[2], out var cost) && cost < BCryptWorkFactor;
    }

    #endregion
}

namespace WatchTogether.Business.DTOs;

// Setup (root user creation)
public class SetupStatusResponse
{
    public bool IsSetupComplete { get; set; }
}

public class CreateRootUserRequest
{
    public string Email { get; set; } = null!;
    public string DisplayName { get; set; } = null!;
    public string Password { get; set; } = null!;
}

// Registration (legacy email-based invitation)
public class RegisterRequest
{
    public string InvitationToken { get; set; } = null!;
    public string DisplayName { get; set; } = null!;
    public string Password { get; set; } = null!;
}

// Registration (new link-based invitation - user provides their email)
public class RegisterWithLinkRequest
{
    public string LinkToken { get; set; } = null!;
    public string Email { get; set; } = null!;
    public string DisplayName { get; set; } = null!;
    public string Password { get; set; } = null!;
}

public class RegisterResponse
{
    public string Email { get; set; } = null!;
    public string Message { get; set; } = null!;
}

// Email verification
public class VerifyEmailRequest
{
    public string Email { get; set; } = null!;
    public string VerificationCode { get; set; } = null!;
}

public class VerifyEmailResponse
{
    public bool Success { get; set; }
    public string Message { get; set; } = null!;
}

public class ResendVerificationRequest
{
    public string Email { get; set; } = null!;
}

// Invitation validation. NOTE: invitee email was deliberately removed —
// the validate endpoint is reachable by anyone holding the token (legitimate
// or otherwise), and returning the invitee email leaks PII via captured
// browser history, referrer headers, sync mechanisms, etc. The registering
// user knows their own email anyway; the UI shouldn't need it from this endpoint.
public class ValidateInvitationResponse
{
    public bool IsValid { get; set; }
    public string? InviterName { get; set; }
    public string? Message { get; set; }
}

// Extended login response with additional info
public class ExtendedLoginResponse : LoginResponse
{
    public bool IsRootUser { get; set; }
    public bool IsInvitationTicketUsed { get; set; }
    public bool HasAcceptedTerms { get; set; }
}

// Authoritative current-user state (no token — caller already has one).
public class MeResponse
{
    public string Email { get; set; } = null!;
    public string DisplayName { get; set; } = null!;
    public bool IsRootUser { get; set; }
    public bool IsInvitationTicketUsed { get; set; }
    public bool HasAcceptedTerms { get; set; }
}

// Terms
public class TermsResponse
{
    public string Version { get; set; } = null!;
    public string Content { get; set; } = null!;
}

public class AcceptTermsRequest
{
    public string Version { get; set; } = null!;
}

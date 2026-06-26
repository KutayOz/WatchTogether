namespace WatchTogether.Business.Services;

public interface IEmailService
{
    Task<bool> SendVerificationEmailAsync(string toEmail, string displayName, string verificationUrl);
    Task<bool> SendInvitationEmailAsync(string toEmail, string inviterName, string invitationLink);
    Task<bool> SendWelcomeEmailAsync(string toEmail, string displayName);

    /// <summary>
    /// Notify the root admin that a new demo request landed. Best-effort —
    /// the public submit endpoint still returns success even if this fails
    /// (otherwise an SMTP blip would be a UX-visible "submission failed" for
    /// the guest).
    /// </summary>
    Task<bool> SendDemoRequestNotificationAsync(
        string adminEmail,
        string requesterEmail,
        string requesterDisplayName,
        string? requesterMessage,
        string adminPanelUrl);

    /// <summary>
    /// Tell the approved requester their invite link is ready. Uses the same
    /// /invite/:token URL format as the regular invitation-link flow, so the
    /// recipient lands in the existing InviteSignup component to finish
    /// registration with their own password.
    /// </summary>
    Task<bool> SendDemoRequestApprovedAsync(
        string toEmail,
        string displayName,
        string invitationUrl);
}

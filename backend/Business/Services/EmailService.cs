using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace WatchTogether.Business.Services;

public class EmailService : IEmailService
{
    private readonly HttpClient _httpClient;
    private readonly string _apiKey;
    private readonly string _fromEmail;
    private readonly string _fromName;
    private readonly string _frontendUrl;
    private readonly bool _isDevelopment;
    private readonly ILogger<EmailService> _logger;

    public EmailService(IConfiguration configuration, ILogger<EmailService> logger)
    {
        _logger = logger;
        _apiKey = configuration["Email:ResendApiKey"] ?? "";
        _fromEmail = configuration["Email:FromEmail"] ?? "noreply@watchtogether.lol";
        _fromName = configuration["Email:FromName"] ?? "WatchTogether";
        _frontendUrl = configuration["App:FrontendUrl"] ?? "http://localhost:5173";
        // Read host environment from the standard ASP.NET Core env var. Avoids pulling
        // Microsoft.Extensions.Hosting into the Business library.
        var aspnetEnv = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") ?? "Production";
        _isDevelopment = string.Equals(aspnetEnv, "Development", StringComparison.OrdinalIgnoreCase);

        _httpClient = new HttpClient
        {
            BaseAddress = new Uri("https://api.resend.com/")
        };
        _httpClient.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", _apiKey);
    }

    /// <summary>
    /// Pretend an email succeeded when no API key is configured, but only in Development.
    /// In production a missing key must surface as a failure so the registration flow rolls back
    /// instead of silently stranding users with no verification email.
    /// </summary>
    private bool TryDevModePassthrough(string scenario, string detail)
    {
        if (!string.IsNullOrEmpty(_apiKey)) return false;
        if (_isDevelopment)
        {
            _logger.LogInformation("[EmailService] (dev) {Scenario} - {Detail}", scenario, detail);
            return true;
        }
        _logger.LogWarning("[EmailService] API key missing in non-Development environment - failing {Scenario}", scenario);
        return false;
    }

    public async Task<bool> SendVerificationEmailAsync(string toEmail, string displayName, string verificationUrl)
    {
        if (string.IsNullOrEmpty(_apiKey))
        {
            return TryDevModePassthrough("verification email", $"URL: {verificationUrl}");
        }

        try
        {
            var payload = new
            {
                from = $"{_fromName} <{_fromEmail}>",
                to = new[] { toEmail },
                subject = "Verify your WatchTogether account",
                html = GetVerificationEmailHtml(displayName, verificationUrl)
            };

            var content = new StringContent(
                JsonSerializer.Serialize(payload),
                Encoding.UTF8,
                "application/json");

            var response = await _httpClient.PostAsync("emails", content);

            if (!response.IsSuccessStatusCode)
            {
                var error = await response.Content.ReadAsStringAsync();
                _logger.LogError("[EmailService] Failed to send verification email: {Error}", error);
                return false;
            }

            _logger.LogInformation("[EmailService] Verification email sent to {Recipient}", Redact(toEmail));
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[EmailService] Exception sending verification email");
            return false;
        }
    }

    public async Task<bool> SendInvitationEmailAsync(string toEmail, string inviterName, string invitationLink)
    {
        if (string.IsNullOrEmpty(_apiKey))
        {
            return TryDevModePassthrough("invitation email", $"link: {invitationLink}");
        }

        try
        {
            var payload = new
            {
                from = $"{_fromName} <{_fromEmail}>",
                to = new[] { toEmail },
                subject = $"{inviterName} invited you to WatchTogether",
                html = GetInvitationEmailHtml(inviterName, invitationLink)
            };

            var content = new StringContent(
                JsonSerializer.Serialize(payload),
                Encoding.UTF8,
                "application/json");

            var response = await _httpClient.PostAsync("emails", content);

            if (!response.IsSuccessStatusCode)
            {
                var error = await response.Content.ReadAsStringAsync();
                _logger.LogError("[EmailService] Failed to send invitation email: {Error}", error);
                return false;
            }

            _logger.LogInformation("[EmailService] Invitation email sent to {Recipient}", Redact(toEmail));
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[EmailService] Exception sending invitation email");
            return false;
        }
    }

    public async Task<bool> SendWelcomeEmailAsync(string toEmail, string displayName)
    {
        if (string.IsNullOrEmpty(_apiKey))
        {
            return TryDevModePassthrough("welcome email", $"to: {toEmail}");
        }

        try
        {
            var payload = new
            {
                from = $"{_fromName} <{_fromEmail}>",
                to = new[] { toEmail },
                subject = "Welcome to WatchTogether!",
                html = GetWelcomeEmailHtml(displayName)
            };

            var content = new StringContent(
                JsonSerializer.Serialize(payload),
                Encoding.UTF8,
                "application/json");

            var response = await _httpClient.PostAsync("emails", content);

            if (!response.IsSuccessStatusCode)
            {
                var error = await response.Content.ReadAsStringAsync();
                _logger.LogError("[EmailService] Failed to send welcome email: {Error}", error);
                return false;
            }

            _logger.LogInformation("[EmailService] Welcome email sent to {Recipient}", Redact(toEmail));
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[EmailService] Exception sending welcome email");
            return false;
        }
    }

    private string GetVerificationEmailHtml(string displayName, string verificationUrl)
    {
        // HTML-encode every interpolation. displayName is user-supplied; without
        // encoding, a username like `<script>alert(1)</script>` becomes stored XSS
        // in any tool that renders the email body (e.g. internal admin tooling,
        // some email clients). verificationUrl goes into an href — browsers
        // generally sanitize javascript: URLs but defense-in-depth: encode it too.
        var encName = WebUtility.HtmlEncode(displayName);
        var encUrl = WebUtility.HtmlEncode(verificationUrl);
        return $@"
<!DOCTYPE html>
<html>
<head>
    <meta charset='utf-8'>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a1a; color: #fff; padding: 40px; }}
        .container {{ max-width: 500px; margin: 0 auto; background: #262626; border-radius: 12px; padding: 40px; }}
        .logo {{ color: #f59e0b; font-size: 24px; font-weight: bold; margin-bottom: 24px; }}
        h1 {{ margin: 0 0 16px; font-size: 20px; }}
        p {{ color: #a3a3a3; line-height: 1.6; margin: 0 0 24px; }}
        .button {{ display: inline-block; background: #f59e0b; color: #000; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 16px 0; }}
        .link {{ color: #f59e0b; word-break: break-all; font-size: 12px; }}
        .footer {{ color: #666; font-size: 12px; margin-top: 32px; }}
    </style>
</head>
<body>
    <div class='container'>
        <div class='logo'>WatchTogether</div>
        <h1>Verify your email</h1>
        <p>Hi {encName},</p>
        <p>Click the button below to verify your email and complete your registration:</p>
        <a href='{encUrl}' class='button'>Verify Email</a>
        <p>Or copy this link:</p>
        <p class='link'>{encUrl}</p>
        <p>This link expires in 24 hours.</p>
        <div class='footer'>If you didn't create an account, you can ignore this email.</div>
    </div>
</body>
</html>";
    }

    private string GetInvitationEmailHtml(string inviterName, string invitationLink)
    {
        var encName = WebUtility.HtmlEncode(inviterName);
        var encUrl = WebUtility.HtmlEncode(invitationLink);
        return $@"
<!DOCTYPE html>
<html>
<head>
    <meta charset='utf-8'>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a1a; color: #fff; padding: 40px; }}
        .container {{ max-width: 500px; margin: 0 auto; background: #262626; border-radius: 12px; padding: 40px; }}
        .logo {{ color: #f59e0b; font-size: 24px; font-weight: bold; margin-bottom: 24px; }}
        h1 {{ margin: 0 0 16px; font-size: 20px; }}
        p {{ color: #a3a3a3; line-height: 1.6; margin: 0 0 24px; }}
        .button {{ display: inline-block; background: #f59e0b; color: #000; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 16px 0; }}
        .link {{ color: #f59e0b; word-break: break-all; font-size: 12px; }}
        .footer {{ color: #666; font-size: 12px; margin-top: 32px; }}
    </style>
</head>
<body>
    <div class='container'>
        <div class='logo'>WatchTogether</div>
        <h1>You're invited!</h1>
        <p><strong>{encName}</strong> has invited you to join WatchTogether - a private video watching platform.</p>
        <p>Click the button below to create your account:</p>
        <a href='{encUrl}' class='button'>Join WatchTogether</a>
        <p>Or copy this link:</p>
        <p class='link'>{encUrl}</p>
        <p>This invitation expires in 7 days.</p>
        <div class='footer'>If you don't know {encName}, you can ignore this email.</div>
    </div>
</body>
</html>";
    }

    /// <summary>
    /// Redact an email for log output. "kutay@watchtogether.app" → "k***@w***.app".
    /// Keeps enough signal for ops triage (first char of local + first char of
    /// domain + TLD) while not dumping full PII into the log aggregator.
    /// </summary>
    private static string Redact(string email)
    {
        if (string.IsNullOrEmpty(email)) return "<empty>";
        var atIdx = email.IndexOf('@');
        if (atIdx <= 0) return "<malformed>";
        var local = email[..atIdx];
        var domain = email[(atIdx + 1)..];
        var dotIdx = domain.LastIndexOf('.');
        var domainHead = dotIdx > 0 ? domain[..dotIdx] : domain;
        var tld = dotIdx > 0 ? domain[dotIdx..] : "";
        return $"{local[0]}***@{(domainHead.Length > 0 ? domainHead[0] : '*')}***{tld}";
    }

    public async Task<bool> SendDemoRequestNotificationAsync(
        string adminEmail,
        string requesterEmail,
        string requesterDisplayName,
        string? requesterMessage,
        string adminPanelUrl)
    {
        if (string.IsNullOrEmpty(_apiKey))
        {
            return TryDevModePassthrough(
                "demo request notification",
                $"admin: {Redact(adminEmail)} requester: {Redact(requesterEmail)}");
        }

        try
        {
            var payload = new
            {
                from = $"{_fromName} <{_fromEmail}>",
                to = new[] { adminEmail },
                subject = $"New demo request from {requesterDisplayName}",
                html = GetDemoRequestNotificationHtml(
                    requesterEmail,
                    requesterDisplayName,
                    requesterMessage,
                    adminPanelUrl)
            };

            var content = new StringContent(
                JsonSerializer.Serialize(payload),
                Encoding.UTF8,
                "application/json");

            var response = await _httpClient.PostAsync("emails", content);

            if (!response.IsSuccessStatusCode)
            {
                var error = await response.Content.ReadAsStringAsync();
                _logger.LogError("[EmailService] Failed to send demo request notification: {Error}", error);
                return false;
            }

            _logger.LogInformation("[EmailService] Demo request notification sent to {Recipient}", Redact(adminEmail));
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[EmailService] Exception sending demo request notification");
            return false;
        }
    }

    public async Task<bool> SendDemoRequestApprovedAsync(string toEmail, string displayName, string invitationUrl)
    {
        if (string.IsNullOrEmpty(_apiKey))
        {
            return TryDevModePassthrough(
                "demo request approved",
                $"to: {Redact(toEmail)} link: {invitationUrl}");
        }

        try
        {
            var payload = new
            {
                from = $"{_fromName} <{_fromEmail}>",
                to = new[] { toEmail },
                subject = "Your WatchTogether demo request was approved",
                html = GetDemoRequestApprovedHtml(displayName, invitationUrl)
            };

            var content = new StringContent(
                JsonSerializer.Serialize(payload),
                Encoding.UTF8,
                "application/json");

            var response = await _httpClient.PostAsync("emails", content);

            if (!response.IsSuccessStatusCode)
            {
                var error = await response.Content.ReadAsStringAsync();
                _logger.LogError("[EmailService] Failed to send demo request approval email: {Error}", error);
                return false;
            }

            _logger.LogInformation("[EmailService] Demo request approval email sent to {Recipient}", Redact(toEmail));
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[EmailService] Exception sending demo request approval email");
            return false;
        }
    }

    private string GetDemoRequestNotificationHtml(
        string requesterEmail,
        string requesterDisplayName,
        string? requesterMessage,
        string adminPanelUrl)
    {
        var encEmail = WebUtility.HtmlEncode(requesterEmail);
        var encName = WebUtility.HtmlEncode(requesterDisplayName);
        var encMsg = string.IsNullOrWhiteSpace(requesterMessage)
            ? "<em>(no message provided)</em>"
            : WebUtility.HtmlEncode(requesterMessage);
        var encUrl = WebUtility.HtmlEncode(adminPanelUrl);
        return $@"
<!DOCTYPE html>
<html>
<head>
    <meta charset='utf-8'>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a1a; color: #fff; padding: 40px; }}
        .container {{ max-width: 500px; margin: 0 auto; background: #262626; border-radius: 12px; padding: 40px; }}
        .logo {{ color: #f59e0b; font-size: 24px; font-weight: bold; margin-bottom: 24px; }}
        h1 {{ margin: 0 0 16px; font-size: 20px; }}
        p {{ color: #a3a3a3; line-height: 1.6; margin: 0 0 16px; }}
        .field {{ background: #1a1a1a; padding: 12px 16px; border-radius: 8px; margin: 8px 0; color: #fff; }}
        .button {{ display: inline-block; background: #f59e0b; color: #000; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 16px 0; }}
        .footer {{ color: #666; font-size: 12px; margin-top: 32px; }}
    </style>
</head>
<body>
    <div class='container'>
        <div class='logo'>WatchTogether</div>
        <h1>New demo request</h1>
        <p>Someone wants in. Details:</p>
        <div class='field'><strong>Name:</strong> {encName}</div>
        <div class='field'><strong>Email:</strong> {encEmail}</div>
        <div class='field'><strong>Message:</strong> {encMsg}</div>
        <p>Review and approve or reject from the admin panel:</p>
        <a href='{encUrl}' class='button'>Open admin panel</a>
        <div class='footer'>This is an automated notification from your WatchTogether instance.</div>
    </div>
</body>
</html>";
    }

    private string GetDemoRequestApprovedHtml(string displayName, string invitationUrl)
    {
        var encName = WebUtility.HtmlEncode(displayName);
        var encUrl = WebUtility.HtmlEncode(invitationUrl);
        return $@"
<!DOCTYPE html>
<html>
<head>
    <meta charset='utf-8'>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a1a; color: #fff; padding: 40px; }}
        .container {{ max-width: 500px; margin: 0 auto; background: #262626; border-radius: 12px; padding: 40px; }}
        .logo {{ color: #f59e0b; font-size: 24px; font-weight: bold; margin-bottom: 24px; }}
        h1 {{ margin: 0 0 16px; font-size: 20px; }}
        p {{ color: #a3a3a3; line-height: 1.6; margin: 0 0 24px; }}
        .button {{ display: inline-block; background: #f59e0b; color: #000; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 16px 0; }}
        .link {{ color: #f59e0b; word-break: break-all; font-size: 12px; }}
        .footer {{ color: #666; font-size: 12px; margin-top: 32px; }}
    </style>
</head>
<body>
    <div class='container'>
        <div class='logo'>WatchTogether</div>
        <h1>You're in!</h1>
        <p>Hi {encName},</p>
        <p>Your demo request was approved. Click below to finish setting up your account:</p>
        <a href='{encUrl}' class='button'>Create your account</a>
        <p>Or copy this link:</p>
        <p class='link'>{encUrl}</p>
        <p>This invitation expires in 48 hours.</p>
        <div class='footer'>If you didn't request a demo, you can ignore this email.</div>
    </div>
</body>
</html>";
    }

    private string GetWelcomeEmailHtml(string displayName)
    {
        var encName = WebUtility.HtmlEncode(displayName);
        // _frontendUrl comes from server config, not user input — encoding is
        // defense-in-depth in case config is ever populated from an untrusted source.
        var encLoginUrl = WebUtility.HtmlEncode($"{_frontendUrl}/login");
        return $@"
<!DOCTYPE html>
<html>
<head>
    <meta charset='utf-8'>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a1a; color: #fff; padding: 40px; }}
        .container {{ max-width: 500px; margin: 0 auto; background: #262626; border-radius: 12px; padding: 40px; }}
        .logo {{ color: #f59e0b; font-size: 24px; font-weight: bold; margin-bottom: 24px; }}
        h1 {{ margin: 0 0 16px; font-size: 20px; }}
        p {{ color: #a3a3a3; line-height: 1.6; margin: 0 0 24px; }}
        .button {{ display: inline-block; background: #f59e0b; color: #000; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; }}
        .footer {{ color: #666; font-size: 12px; margin-top: 32px; }}
    </style>
</head>
<body>
    <div class='container'>
        <div class='logo'>WatchTogether</div>
        <h1>Welcome to WatchTogether!</h1>
        <p>Hi {encName},</p>
        <p>Your account has been verified and you're all set. Start watching content with friends in real-time!</p>
        <a href='{encLoginUrl}' class='button'>Go to WatchTogether</a>
        <div class='footer'>Thanks for joining WatchTogether.</div>
    </div>
</body>
</html>";
    }
}

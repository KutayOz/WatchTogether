using System.Net.Http;
using System.Security.Cryptography;
using System.Text;

namespace WatchTogether.Business.Validators;

public static class PasswordValidator
{
    /// <summary>
    /// Minimum length bumped from 8 to 12 per NIST 800-63B / OWASP 2026
    /// guidance: long passwords beat complex short ones. 12 is the modern
    /// floor; existing users with shorter passwords can still log in (only
    /// registration + password-change runs this validator) but can't reset
    /// to anything weaker.
    /// </summary>
    private const int MinLength = 12;

    /// <summary>
    /// Cap so that BCrypt — which silently truncates at 72 bytes — isn't fed
    /// huge inputs that allocate large strings in middleware before truncation.
    /// Also blocks the obvious DoS-by-100KB-password attack.
    /// </summary>
    private const int MaxLength = 256;

    public static (bool IsValid, List<string> Errors) Validate(string password)
    {
        var errors = new List<string>();

        if (string.IsNullOrEmpty(password))
        {
            errors.Add("Password is required");
            return (false, errors);
        }

        if (password.Length < MinLength)
            errors.Add($"Password must be at least {MinLength} characters");

        if (password.Length > MaxLength)
            errors.Add($"Password must be at most {MaxLength} characters");

        if (!password.Any(char.IsUpper))
            errors.Add("Password must contain at least one uppercase letter");

        if (!password.Any(char.IsLower))
            errors.Add("Password must contain at least one lowercase letter");

        if (!password.Any(char.IsDigit))
            errors.Add("Password must contain at least one number");

        return (errors.Count == 0, errors);
    }

    /// <summary>
    /// HaveIBeenPwned k-anonymity check. Computes SHA-1 of the password
    /// locally, sends only the first 5 hex characters to api.pwnedpasswords.com,
    /// and looks for the remaining suffix in the returned list. The plaintext
    /// password never leaves the server, and the prefix alone reveals nothing
    /// (~478 hashes share any given 5-char prefix).
    ///
    /// Returns true if the password is in HIBP's breach corpus. Caller should
    /// reject registration in that case.
    ///
    /// Fail-open: network errors / timeouts return false so an HIBP outage
    /// doesn't lock everyone out of registration. The other PasswordValidator
    /// rules still apply, so we don't lose much by not blocking here.
    /// </summary>
    public static async Task<bool> IsPwnedAsync(string password, HttpClient httpClient, CancellationToken cancellationToken = default)
    {
        try
        {
            // SHA-1 is deliberately used here — that's what HIBP's API expects.
            // We're NOT using it for security (the API contract requires it);
            // SHA-1's weakness as a cryptographic hash is irrelevant for the
            // anonymity property of this lookup.
            var hashBytes = SHA1.HashData(Encoding.UTF8.GetBytes(password));
            var hex = Convert.ToHexString(hashBytes); // uppercase by default; HIBP returns uppercase too
            var prefix = hex[..5];
            var suffix = hex[5..];

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(TimeSpan.FromSeconds(2)); // Hard 2s budget — HIBP is usually <100ms.

            using var request = new HttpRequestMessage(HttpMethod.Get, $"https://api.pwnedpasswords.com/range/{prefix}");
            // HIBP recommends sending this header so they can attribute traffic.
            request.Headers.Add("User-Agent", "WatchTogether-Backend");
            using var response = await httpClient.SendAsync(request, cts.Token);

            if (!response.IsSuccessStatusCode) return false; // Fail open on non-200.

            var body = await response.Content.ReadAsStringAsync(cts.Token);
            // Each line is "SUFFIX:COUNT" — we only care that our suffix is present.
            foreach (var rawLine in body.Split('\n'))
            {
                var colonIdx = rawLine.IndexOf(':');
                if (colonIdx <= 0) continue;
                var lineSuffix = rawLine[..colonIdx].Trim();
                if (string.Equals(lineSuffix, suffix, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }
        catch
        {
            // Network blip, DNS failure, timeout — fail open. The basic
            // PasswordValidator.Validate rules already passed, so we're not
            // accepting an obviously weak password here.
            return false;
        }
    }
}

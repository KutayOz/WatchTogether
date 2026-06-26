using System.Collections.Concurrent;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using WatchTogether.Business.Models;

namespace WatchTogether.Business.Services;

public class SessionService : ISessionService
{
    private readonly ConcurrentDictionary<string, Session> _sessions = new();
    private readonly ConcurrentDictionary<string, SessionInvite> _invites = new();
    private readonly IConfiguration _configuration;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<SessionService> _logger;
    private const int MaxParticipants = 2;
    private const int SessionGracePeriodMinutes = 5; // Keep empty sessions for 5 minutes
    private const int InviteExpiryMinutes = 15;

    public SessionService(IConfiguration configuration, IHttpClientFactory httpClientFactory, ILogger<SessionService> logger)
    {
        _configuration = configuration;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public string CreateSession(string creatorUserId)
    {
        // Eager cleanup on the write path; the BackgroundService also runs periodically
        // so quiet periods don't leak. Both call sites are safe to invoke concurrently
        // because the ConcurrentDictionary + per-session lock guard the mutations.
        RunSessionCleanup();

        var sessionId = GenerateSessionId();
        var session = new Session { Id = sessionId, CreatorUserId = creatorUserId };
        _sessions.TryAdd(sessionId, session);
        return sessionId;
    }

    public Session? GetSession(string sessionId)
    {
        _sessions.TryGetValue(sessionId, out var session);
        return session;
    }

    public bool SessionExists(string sessionId)
    {
        return _sessions.ContainsKey(sessionId);
    }

    public bool AddParticipant(string sessionId, string connectionId, string email, string displayName)
    {
        // Session must exist - only CreateSession should create sessions
        if (!_sessions.TryGetValue(sessionId, out var session))
        {
            return false;
        }

        lock (session)
        {
            if (session.Participants.Count >= MaxParticipants)
                return false;

            if (session.Participants.Any(p => p.ConnectionId == connectionId))
                return true;

            session.Participants.Add(new Participant
            {
                ConnectionId = connectionId,
                Email = email,
                DisplayName = displayName
            });

            // Clear EmptySince since session now has participants
            session.EmptySince = null;

            return true;
        }
    }

    public void RemoveParticipant(string sessionId, string connectionId)
    {
        if (!_sessions.TryGetValue(sessionId, out var session))
            return;

        lock (session)
        {
            session.Participants.RemoveAll(p => p.ConnectionId == connectionId);

            // Don't delete immediately - mark as empty for grace period
            if (session.Participants.Count == 0)
            {
                session.EmptySince = DateTime.UtcNow;
            }
        }
    }

    public int GetParticipantCount(string sessionId)
    {
        if (!_sessions.TryGetValue(sessionId, out var session))
            return 0;
        return session.Participants.Count;
    }

    public List<Participant> GetOtherParticipants(string sessionId, string excludeConnectionId)
    {
        if (!_sessions.TryGetValue(sessionId, out var session))
            return new List<Participant>();

        lock (session)
        {
            return session.Participants
                .Where(p => p.ConnectionId != excludeConnectionId)
                .ToList();
        }
    }

    public async Task<IceServerConfig> GetIceServersAsync(string userId)
    {
        var config = new IceServerConfig();

        // STUN servers (free, for NAT traversal discovery)
        config.IceServers.Add(new IceServer { Urls = "stun:stun.l.google.com:19302" });
        config.IceServers.Add(new IceServer { Urls = "stun:stun1.l.google.com:19302" });

        // Preferred path: Cloudflare Realtime TURN. Istanbul PoP + anycast (low
        // latency for our users) and short-lived minted credentials (a leak can't
        // be abused long-term). If configured, use it exclusively and return.
        var cfKeyId = _configuration["WebRTC:CloudflareTurnKeyId"];
        var cfApiToken = _configuration["WebRTC:CloudflareTurnApiToken"];
        if (!string.IsNullOrEmpty(cfKeyId) && !string.IsNullOrEmpty(cfApiToken))
        {
            await TryAddCloudflareTurnAsync(config, cfKeyId, cfApiToken);
            return config;
        }

        var turnServer = _configuration["WebRTC:TurnServer"];

        // Support legacy TurnUrl config
        if (string.IsNullOrEmpty(turnServer))
        {
            turnServer = _configuration["WebRTC:TurnUrl"];
        }

        if (string.IsNullOrEmpty(turnServer))
        {
            // No TURN configured at all — STUN-only is fine for symmetric NATs and
            // most networks; users behind strict firewalls may not be able to connect.
            return config;
        }

        // Pick the credentials. Two schemes:
        //
        //   A. Time-bound (preferred): TurnAuthSecret env var is set, coturn is
        //      configured with `use-auth-secret` + matching `static-auth-secret`.
        //      We mint a fresh username/credential pair per request that expires
        //      in ~1 hour. An attacker who extracts the creds from the wire can
        //      only abuse them for that window.
        //
        //   B. Static (legacy): TurnUsername/TurnCredential env vars set, same
        //      pair returned to everyone forever. An attacker can extract them
        //      once and reuse indefinitely as a free relay.
        var authSecret = _configuration["WebRTC:TurnAuthSecret"];
        string? turnUsername;
        string? turnCredential;
        if (!string.IsNullOrEmpty(authSecret))
        {
            var ttlSeconds = int.TryParse(_configuration["WebRTC:TurnCredentialTtlSeconds"], out var parsedTtl) ? parsedTtl : 3600;
            (turnUsername, turnCredential) = MintTurnCredentials(authSecret, userId, ttlSeconds);
        }
        else
        {
            turnUsername = _configuration["WebRTC:TurnUsername"];
            turnCredential = _configuration["WebRTC:TurnCredential"];
        }

        if (string.IsNullOrEmpty(turnUsername))
        {
            // TURN URL configured but no credentials at all — skip.
            return config;
        }

        // Parse host + (optional) port from the configured URL. The OLD code
        // stripped the real port and hard-coded :443 on all three entries, so any
        // TURN server NOT listening on 443 (coturn defaults: 3478 for turn, 5349
        // for turns) was silently unreachable → clients fell back to STUN-only →
        // relay failed on strict networks. We now RESPECT the operator's port.
        var stripped = turnServer
            .Replace("turn:", "")
            .Replace("turns:", "")
            .Replace("stun:", "")
            .Split('?')[0]  // drop any query params
            .Trim();
        var parts = stripped.Split(':');
        var host = parts[0].Trim();

        // turn (UDP/TCP) port: from the URL if present, else the standard 3478.
        var turnPort = parts.Length > 1 && int.TryParse(parts[1], out var parsedPort)
            && parsedPort is > 0 and <= 65535
            ? parsedPort
            : 3478;

        // turns (TLS) port: separate by convention. Default 5349; override with
        // WebRTC:TurnTlsPort (set it to 443 if you front TURN-over-TLS on 443 for
        // firewall traversal).
        var tlsPort = int.TryParse(_configuration["WebRTC:TurnTlsPort"], out var parsedTls)
            ? parsedTls
            : 5349;

        // TURN over UDP - lowest-latency relay path.
        config.IceServers.Add(new IceServer
        {
            Urls = $"turn:{host}:{turnPort}",
            Username = turnUsername,
            Credential = turnCredential
        });

        // TURN over TCP - helps with restrictive firewalls that block UDP.
        config.IceServers.Add(new IceServer
        {
            Urls = $"turn:{host}:{turnPort}?transport=tcp",
            Username = turnUsername,
            Credential = turnCredential
        });

        // TURNS over TLS - most reliable for strict networks (looks like HTTPS).
        config.IceServers.Add(new IceServer
        {
            Urls = $"turns:{host}:{tlsPort}?transport=tcp",
            Username = turnUsername,
            Credential = turnCredential
        });

        return config;
    }

    /// <summary>
    /// Mint short-lived TURN credentials from Cloudflare Realtime and append the
    /// returned ICE servers to <paramref name="config"/>. Cloudflare returns each
    /// server with a urls[] array; our IceServer model carries a single url, so we
    /// flatten one entry per url. On ANY failure we log and return without adding
    /// TURN — a failed mint must never break the ice-servers response (callers
    /// still get STUN, and the call still works for non-relay paths).
    /// </summary>
    private async Task TryAddCloudflareTurnAsync(IceServerConfig config, string keyId, string apiToken)
    {
        try
        {
            var ttl = int.TryParse(_configuration["WebRTC:CloudflareTurnTtlSeconds"], out var t) ? t : 86400;
            var http = _httpClientFactory.CreateClient();
            http.Timeout = TimeSpan.FromSeconds(5);

            using var req = new HttpRequestMessage(
                HttpMethod.Post,
                $"https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate-ice-servers");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiToken);
            req.Content = JsonContent.Create(new { ttl });

            using var resp = await http.SendAsync(req);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("[ICE] Cloudflare TURN mint failed: HTTP {StatusCode}", (int)resp.StatusCode);
                return;
            }

            var payload = await resp.Content.ReadFromJsonAsync<CloudflareIceResponse>();
            if (payload?.IceServers == null) return;

            // Flatten Cloudflare's urls[] per server into one IceServer per url.
            foreach (var server in payload.IceServers)
            {
                if (server.Urls == null) continue;
                foreach (var url in server.Urls)
                {
                    config.IceServers.Add(new IceServer
                    {
                        Urls = url,
                        Username = server.Username,
                        Credential = server.Credential,
                    });
                }
            }
        }
        catch (Exception ex)
        {
            // Network blip, timeout, bad token — degrade to STUN-only rather than 500.
            _logger.LogWarning(ex, "[ICE] Cloudflare TURN mint error");
        }
    }

    private sealed class CloudflareIceResponse
    {
        [JsonPropertyName("iceServers")]
        public List<CloudflareIceServer>? IceServers { get; set; }
    }

    private sealed class CloudflareIceServer
    {
        [JsonPropertyName("urls")]
        public List<string>? Urls { get; set; }

        [JsonPropertyName("username")]
        public string? Username { get; set; }

        [JsonPropertyName("credential")]
        public string? Credential { get; set; }
    }

    /// <summary>
    /// Coturn time-bound REST API auth scheme.
    /// Reference: https://datatracker.ietf.org/doc/html/draft-uberti-behave-turn-rest-00
    ///
    /// username  = "{unixExpiry}:{userId}"
    /// credential = base64( HMAC-SHA1( authSecret, username ) )
    ///
    /// The TURN server (coturn with `use-auth-secret` + matching `static-auth-secret`)
    /// validates the HMAC and rejects requests where unixExpiry has passed. No
    /// database lookup needed on either side — purely stateless.
    /// </summary>
    private static (string username, string credential) MintTurnCredentials(
        string authSecret, string userId, int ttlSeconds)
    {
        var expiry = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + ttlSeconds;
        var username = $"{expiry}:{userId}";

        using var hmac = new HMACSHA1(Encoding.UTF8.GetBytes(authSecret));
        var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(username));
        var credential = Convert.ToBase64String(hash);

        return (username, credential);
    }

    #region Session Invites

    public GenerateSessionInviteResult GenerateInvite(string sessionId, string userId, string frontendUrl)
    {
        // Clean up expired invites
        CleanupExpiredInvites();

        // Verify session exists
        if (!_sessions.TryGetValue(sessionId, out var ownershipSession))
        {
            return new GenerateSessionInviteResult
            {
                Success = false,
                Message = "Session does not exist"
            };
        }

        // Verify caller created the session — defends against unauthorized invite generation (IDOR)
        if (ownershipSession.CreatorUserId != userId)
        {
            return new GenerateSessionInviteResult
            {
                Success = false,
                Message = "You are not the creator of this session"
            };
        }

        // Check if session is full
        var participantCount = GetParticipantCount(sessionId);
        if (participantCount >= MaxParticipants)
        {
            return new GenerateSessionInviteResult
            {
                Success = false,
                Message = "Session is already full"
            };
        }

        // Check for existing active invite for this session
        var existingInvite = _invites.Values.FirstOrDefault(i =>
            i.SessionId == sessionId &&
            !i.IsUsed &&
            i.ExpiresAt > DateTime.UtcNow);

        if (existingInvite != null)
        {
            // Return existing invite
            return new GenerateSessionInviteResult
            {
                Success = true,
                InviteUrl = $"{frontendUrl}/join/{existingInvite.Token}",
                Token = existingInvite.Token,
                ExpiresAt = existingInvite.ExpiresAt
            };
        }

        // Generate new invite
        var token = GenerateSecureToken();
        var invite = new SessionInvite
        {
            Token = token,
            SessionId = sessionId,
            CreatedByUserId = userId,
            CreatedAt = DateTime.UtcNow,
            ExpiresAt = DateTime.UtcNow.AddMinutes(InviteExpiryMinutes)
        };

        _invites.TryAdd(token, invite);

        return new GenerateSessionInviteResult
        {
            Success = true,
            InviteUrl = $"{frontendUrl}/join/{token}",
            Token = token,
            ExpiresAt = invite.ExpiresAt
        };
    }

    public ValidateSessionInviteResult ValidateInvite(string token)
    {
        if (!_invites.TryGetValue(token, out var invite))
        {
            return new ValidateSessionInviteResult
            {
                Valid = false,
                Message = "Invalid invite link"
            };
        }

        if (invite.IsUsed)
        {
            return new ValidateSessionInviteResult
            {
                Valid = false,
                Message = "This invite link has already been used"
            };
        }

        if (invite.ExpiresAt <= DateTime.UtcNow)
        {
            return new ValidateSessionInviteResult
            {
                Valid = false,
                Message = "This invite link has expired"
            };
        }

        // Check if session still exists and has room
        if (!_sessions.TryGetValue(invite.SessionId, out var session))
        {
            return new ValidateSessionInviteResult
            {
                Valid = false,
                Message = "The session no longer exists"
            };
        }

        if (session.Participants.Count >= MaxParticipants)
        {
            return new ValidateSessionInviteResult
            {
                Valid = false,
                Message = "The session is already full"
            };
        }

        // Get creator's display name from session participants
        var creator = session.Participants.FirstOrDefault();

        return new ValidateSessionInviteResult
        {
            Valid = true,
            SessionId = invite.SessionId,
            CreatorDisplayName = creator?.DisplayName
        };
    }

    /// <summary>
    /// Atomically mark a session invite as used. Returns true iff THIS call won
    /// the race to flip the flag from 0→1; false if the invite was already used
    /// (by a concurrent caller or a previous request). Callers MUST check the
    /// return value to ensure single-use semantics — the previous bool-set
    /// version had a TOCTOU where ValidateInvite returned Valid=true to two
    /// callers and both then "succeeded" at marking used.
    /// </summary>
    public bool MarkInviteUsed(string token, string userId)
    {
        if (!_invites.TryGetValue(token, out var invite)) return false;
        // CompareExchange returns the OLD value. If 0, we just flipped it.
        // If non-zero, someone else flipped it first — we lose the race.
        var prev = System.Threading.Interlocked.CompareExchange(ref invite.UsedFlag, 1, 0);
        if (prev != 0) return false;
        invite.UsedByUserId = userId; // safe: only the winning caller reaches here
        return true;
    }

    private int CleanupExpiredInvites()
    {
        var now = DateTime.UtcNow;
        var expiredTokens = _invites
            .Where(kvp => kvp.Value.ExpiresAt <= now || kvp.Value.IsUsed)
            .Select(kvp => kvp.Key)
            .ToList();

        foreach (var token in expiredTokens)
        {
            _invites.TryRemove(token, out _);
        }

        return expiredTokens.Count;
    }

    // Periodic-cleanup entry points called by SessionCleanupHostedService.
    // These wrap the existing private cleanup logic; the rest of the class still calls
    // the private methods on the write path, so behavior is additive (timer + write-path).
    public int RunInviteCleanup() => CleanupExpiredInvites();
    public int RunSessionCleanup()
    {
        var cutoff = DateTime.UtcNow.AddMinutes(-SessionGracePeriodMinutes);
        var removed = 0;
        foreach (var kvp in _sessions)
        {
            var session = kvp.Value;
            lock (session)
            {
                if (session.EmptySince.HasValue && session.EmptySince.Value < cutoff)
                {
                    if (_sessions.TryRemove(kvp.Key, out _)) removed++;
                }
            }
        }
        return removed;
    }

    private static string GenerateSecureToken()
    {
        var bytes = new byte[32];
        RandomNumberGenerator.Fill(bytes);
        return Convert.ToBase64String(bytes)
            .Replace("+", "-")
            .Replace("/", "_")
            .Replace("=", "");
    }

    #endregion

    /// <summary>
    /// Generate an unguessable session ID. Was previously
    /// <c>Guid.NewGuid().ToString("N")[..8]</c> — 32 bits, ~4.3B keyspace,
    /// realistically enumerable at distributed scale (and birthday-collision-prone
    /// past ~65k concurrent sessions).
    ///
    /// 12 random bytes → 16 base64url chars → 96 bits of entropy. Enough that brute
    /// force is mathematically infeasible (10²⁹ years at 1T guesses/sec) without
    /// being as ugly in the URL bar as a 43-char 256-bit token.
    /// </summary>
    private static string GenerateSessionId()
    {
        var bytes = new byte[12];
        RandomNumberGenerator.Fill(bytes);
        return Convert.ToBase64String(bytes)
            .Replace("+", "-")
            .Replace("/", "_")
            .Replace("=", "");
    }
}

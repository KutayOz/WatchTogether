using System.Text;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.IdentityModel.Tokens;
using WatchTogether.API.HostedServices;
using WatchTogether.API.Hubs;
using Fido2NetLib;
using WatchTogether.Business.Services;
using WatchTogether.Data.Context;
using WatchTogether.Data.Repositories;

var builder = WebApplication.CreateBuilder(args);

// Bind to PORT env var (Railway / most PaaS conventions); default 5000 for local dev.
var port = Environment.GetEnvironmentVariable("PORT") ?? "5000";
builder.WebHost.UseUrls($"http://*:{port}");

// Validate the JWT secret at startup — fail fast, not at first auth request.
// Three rejected cases:
//   1. Missing or under 32 bytes (HS256 requires >=256-bit key)
//   2. The placeholder shipped in appsettings.Development.json (catches "forgot to set it" misconfig)
//   3. Any value starting with "DEV_ONLY_" outside Development env (defense-in-depth against
//      accidentally promoting a known dev secret to prod — even old git history can't bite us)
{
    var jwtSecret = builder.Configuration["Jwt:Secret"];
    var isDev = builder.Environment.IsDevelopment();
    if (string.IsNullOrWhiteSpace(jwtSecret) || jwtSecret == "__SET_VIA_USER_SECRETS_OR_ENV__")
    {
        throw new InvalidOperationException(
            isDev
                ? "Jwt:Secret is not set. Run:\n" +
                  "  dotnet user-secrets init\n" +
                  "  dotnet user-secrets set Jwt:Secret \"$(openssl rand -base64 48)\"\n" +
                  "(from /backend/API directory)"
                : "Jwt:Secret env var is missing in non-Development environment. Set Jwt__Secret.");
    }
    if (Encoding.UTF8.GetByteCount(jwtSecret) < 32)
    {
        throw new InvalidOperationException("Jwt:Secret must be at least 32 bytes (>=256 bits).");
    }
    if (!isDev && jwtSecret.StartsWith("DEV_ONLY_", StringComparison.Ordinal))
    {
        throw new InvalidOperationException(
            "Jwt:Secret starts with 'DEV_ONLY_' but environment is not Development. " +
            "This usually means a dev secret leaked into prod config — generate a fresh secret and set Jwt__Secret.");
    }
}


// Controllers
builder.Services.AddControllers();

// Named HttpClient for outbound calls (HIBP password breach check + room for
// any future webhook / external API). IHttpClientFactory handles socket pooling
// and DNS lifetime correctly — never `new HttpClient()` per request.
builder.Services.AddHttpClient();

// SignalR
builder.Services.AddSignalR();

// MongoDB
builder.Services.AddSingleton<MongoDbContext>();
builder.Services.AddScoped<IUserRepository, UserRepository>();
builder.Services.AddScoped<IInvitationRepository, InvitationRepository>();
builder.Services.AddScoped<IInvitationLinkRepository, InvitationLinkRepository>();
builder.Services.AddScoped<IRevokedTokenRepository, RevokedTokenRepository>();
builder.Services.AddScoped<IAdminAuditLogRepository, AdminAuditLogRepository>();
builder.Services.AddScoped<IDemoRequestRepository, DemoRequestRepository>();

// Business Services
builder.Services.AddSingleton<ISessionService, SessionService>();
builder.Services.AddSingleton<ISpeedTestService, SpeedTestService>();

// Background cleanup of in-memory sessions/invites — runs independently of write traffic.
// Without this, quiet periods (overnight) leak expired entries until the next CreateSession.
builder.Services.AddHostedService<SessionCleanupHostedService>();
builder.Services.AddScoped<IEmailService, EmailService>();
builder.Services.AddScoped<IAuthService, AuthService>();
builder.Services.AddScoped<IInvitationService, InvitationService>();
builder.Services.AddScoped<IInvitationLinkService, InvitationLinkService>();
builder.Services.AddScoped<IDemoRequestService, DemoRequestService>();

// Passkey / WebAuthn. IMemoryCache holds short-lived (2 min) challenges
// between Begin and Finish; if we ever go multi-instance, swap for
// IDistributedCache (Redis) — PasskeyService only depends on IMemoryCache.
builder.Services.AddMemoryCache();
builder.Services.AddFido2(options =>
{
    var passkeyConfig = builder.Configuration.GetSection("Passkey");
    // ServerDomain is the eTLD+1 the relying-party identity is scoped to.
    // It MUST match the origin the user is browsing — "localhost" in dev,
    // your real domain in prod. If it doesn't, every passkey registration
    // fails with "Origin not allowed" and you'll spend an hour debugging.
    options.ServerDomain = passkeyConfig["ServerDomain"] ?? "localhost";
    options.ServerName = passkeyConfig["ServerName"] ?? "WatchTogether";
    // Origins is the set of full origins (scheme + host [+port]) we accept
    // assertions from. Comma-separated in config for easy override per env.
    var origins = passkeyConfig["Origins"]?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        ?? new[] { "http://localhost:5173" };
    options.Origins = new HashSet<string>(origins);
    // Tolerance lets ~5 min of clock drift between authenticator and server.
    options.TimestampDriftTolerance = 300_000;
});
builder.Services.AddScoped<IPasskeyService, PasskeyService>();

// JWT Authentication
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        var jwtSecret = builder.Configuration["Jwt:Secret"];
        if (string.IsNullOrWhiteSpace(jwtSecret) || Encoding.UTF8.GetByteCount(jwtSecret) < 32)
            throw new InvalidOperationException("Jwt:Secret must be set to >=32 bytes (set Jwt__Secret env var)");

        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer = builder.Configuration["Jwt:Issuer"],
            ValidAudience = builder.Configuration["Jwt:Audience"],
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtSecret))
        };

        // Token sources, in priority order:
        //   1. Authorization: Bearer <token>      (legacy / API testing)
        //   2. ?access_token=...                  (SignalR WebSocket — can't set
        //                                          custom headers on the upgrade)
        //   3. Cookie: wt_auth=<token>            (primary path post-C4 — set by
        //                                          /api/auth/login, HttpOnly so JS
        //                                          can't exfiltrate via XSS)
        // We don't have to special-case (3) because JwtBearerHandler reads (1) by
        // default. We only override here for (2) and (3) when (1) is empty.
        options.Events = new JwtBearerEvents
        {
            // After signature + lifetime validation, check the JWT's jti against
            // the deny-list collection. Revoked tokens get rejected here so any
            // [Authorize] endpoint downstream sees an unauthenticated request.
            // One indexed point query per request — ~5ms; negligible at our scale.
            OnTokenValidated = async context =>
            {
                var jti = context.Principal?.FindFirst(System.IdentityModel.Tokens.Jwt.JwtRegisteredClaimNames.Jti)?.Value;
                if (string.IsNullOrEmpty(jti)) return; // No jti claim — let it pass (legacy tokens predate this fix).

                var revokedRepo = context.HttpContext.RequestServices.GetRequiredService<IRevokedTokenRepository>();
                if (await revokedRepo.IsRevokedAsync(jti))
                {
                    context.Fail("Token has been revoked.");
                }
            },
            OnMessageReceived = context =>
            {
                // Skip if Authorization header already provided a token.
                if (!string.IsNullOrEmpty(context.Token)) return Task.CompletedTask;

                var request = context.HttpContext.Request;
                var path = request.Path;

                // SignalR query-string fallback (kept for now — used by current client)
                var accessToken = request.Query["access_token"];
                if (!string.IsNullOrEmpty(accessToken) && path.StartsWithSegments("/hubs"))
                {
                    context.Token = accessToken;
                    return Task.CompletedTask;
                }

                // HttpOnly cookie — the primary path now. Sent automatically by
                // the browser on REST calls (credentials:'include') and SignalR
                // (withCredentials:true on the connection options).
                if (request.Cookies.TryGetValue("wt_auth", out var cookieToken)
                    && !string.IsNullOrEmpty(cookieToken))
                {
                    context.Token = cookieToken;
                }

                return Task.CompletedTask;
            }
        };
    });

// CORS
var allowedOrigins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>()
    ?? new[] { "http://localhost:5173" };

// Production guard: if Cors__AllowedOrigins env var is missing in Production we'd
// fall through to the localhost defaults — letting any localhost-running process
// (browser extension, malware, another app) make credentialed requests against
// the public API. Fail fast and loudly so the misconfig is caught at boot, not
// after the first leaked request.
if (!builder.Environment.IsDevelopment())
{
    var hasLocalhost = allowedOrigins.Any(o =>
        o.Contains("localhost", StringComparison.OrdinalIgnoreCase) ||
        o.Contains("127.0.0.1") ||
        o.Contains("::1"));
    if (hasLocalhost)
    {
        throw new InvalidOperationException(
            "Cors:AllowedOrigins contains localhost/loopback entries in a non-Development environment. " +
            $"Set Cors__AllowedOrigins to the production frontend domain(s). Got: [{string.Join(", ", allowedOrigins)}]");
    }
    if (allowedOrigins.Length == 0)
    {
        throw new InvalidOperationException(
            "Cors:AllowedOrigins is empty in a non-Development environment. " +
            "Set Cors__AllowedOrigins to the production frontend domain(s).");
    }
}

builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowFrontend", policy =>
    {
        policy.WithOrigins(allowedOrigins)
              .WithMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
              .WithHeaders("Authorization", "Content-Type", "x-signalr-user-agent", "x-requested-with",
                           "x-payload-size", "x-client-timestamp")
              .AllowCredentials();
    });
});

// Rate Limiting
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    // Global rate limit: 100 requests per minute per IP
    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 100,
                Window = TimeSpan.FromMinutes(1)
            }));

    // Login limit: 5 attempts per minute per IP (tightened from 15 — defends credential stuffing)
    options.AddPolicy("auth-login", context =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 5,
                Window = TimeSpan.FromMinutes(1),
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit = 0 // No queuing - reject immediately
            }));

    // Registration limit: 3 per 5 minutes per IP (tightened from 5/min)
    options.AddPolicy("auth-register", context =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 3,
                Window = TimeSpan.FromMinutes(5),
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit = 0
            }));

    // Resend verification: 3 per 15 minutes per IP
    options.AddPolicy("auth-resend", context =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 3,
                Window = TimeSpan.FromMinutes(15),
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit = 0
            }));

    // Email verification token: 10 per minute per IP (prevent enumeration)
    options.AddPolicy("auth-verify", context =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 10,
                Window = TimeSpan.FromMinutes(1),
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit = 0
            }));

    // General "auth" bucket: 20 per minute per IP. Used by setup/status,
    // google sign-in, and passkey auth begin/finish — endpoints that
    // don't fit the tighter login/register buckets but still need
    // a cap. Without this policy the [EnableRateLimiting("auth")]
    // attribute throws InvalidOperationException at request time → 500
    // for callers (caught by /setup/status during the diag of this bug).
    options.AddPolicy("auth", context =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 20,
                Window = TimeSpan.FromMinutes(1),
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit = 0
            }));

    // Invitation validation: 20 per minute per IP
    options.AddPolicy("invitation", context =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 20,
                Window = TimeSpan.FromMinutes(1),
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit = 0
            }));

    // Session lookup: 30 per minute per IP. Covers {id}/validate (don't let an
    // attacker brute-force the 96-bit session space to enumerate live sessions)
    // and ice-servers (hands out TURN credentials — throttle the mint). Generous
    // vs. real use: a client hits each at most a few times per session join.
    options.AddPolicy("session", context =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 30,
                Window = TimeSpan.FromMinutes(1),
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit = 0
            }));

    // Demo request submission: 3 per 5 min per IP. Public anonymous endpoint
    // emails the admin on every fresh submission — tight cap so a single IP
    // can't flood the inbox. Service layer also deduplicates by email within
    // the Pending state, so the same person resubmitting silently no-ops.
    options.AddPolicy("demo-request", context =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 3,
                Window = TimeSpan.FromMinutes(5),
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit = 0
            }));

    // Custom response for rate limit exceeded
    options.OnRejected = async (context, cancellationToken) =>
    {
        context.HttpContext.Response.StatusCode = StatusCodes.Status429TooManyRequests;
        context.HttpContext.Response.ContentType = "application/json";

        var retryAfter = context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfterValue)
            ? retryAfterValue.TotalSeconds
            : 60;

        context.HttpContext.Response.Headers.RetryAfter = ((int)retryAfter).ToString();

        await context.HttpContext.Response.WriteAsJsonAsync(new
        {
            message = "Too many requests. Please try again later.",
            retryAfterSeconds = (int)retryAfter
        }, cancellationToken);
    };
});

var app = builder.Build();

// TURN credential legacy-mode warning. The H3 fix added per-user time-bound
// HMAC credentials, but that's only active when WebRTC:TurnAuthSecret is set
// (matching coturn's --use-auth-secret). If TurnServer is configured but the
// shared secret isn't, we silently fall back to the static username/credential
// pair — exactly the leak vector H3 was supposed to close. Surface this loudly
// so the operator knows they're running in legacy mode.
{
    var turnServer = app.Configuration["WebRTC:TurnServer"] ?? app.Configuration["WebRTC:TurnUrl"];
    var turnAuthSecret = app.Configuration["WebRTC:TurnAuthSecret"];
    if (!app.Environment.IsDevelopment()
        && !string.IsNullOrEmpty(turnServer)
        && string.IsNullOrEmpty(turnAuthSecret))
    {
        app.Logger.LogWarning(
            "WebRTC:TurnAuthSecret is not set. Falling back to static TURN " +
            "credentials shared across every authed user — anyone with an account " +
            "can extract the username/credential from /api/session/ice-servers and " +
            "reuse them as a free TURN relay. Set WebRTC__TurnAuthSecret and " +
            "configure coturn with `use-auth-secret` + matching `static-auth-secret` " +
            "to enable per-user time-bound credentials (H3 audit fix).");
    }
}

// Honor X-Forwarded-* from Railway's edge proxy so:
//   - Request.Scheme == "https" (correct HSTS / redirects / cookie Secure flag)
//   - Connection.RemoteIpAddress is the real client IP (correct rate-limit partitioning)
//
// IMPORTANT: ForwardedHeadersOptions only applies the headers when the *immediate* hop is
// in KnownNetworks/KnownProxies. By default that's loopback only — which means in any
// PaaS container (Railway, Fly.io, Render, etc.) the headers are silently dropped and
// Request.Scheme stays HTTP. The previous `.Clear()` calls made this worse, not better.
//
// We trust ALL networks here. That's not loose security: the only network path to the
// container is via the platform's proxy, so every incoming request *must* have passed
// through it. For self-hosted deploys behind a specific reverse proxy, replace these
// wildcard ranges with the proxy's actual CIDR.
var forwardedHeadersOptions = new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
    // ForwardLimit defaults to 1, which is correct for a single edge proxy. Increase if
    // a chain of trusted proxies sits in front (uncommon on Railway).
    ForwardLimit = 1,
};
forwardedHeadersOptions.KnownNetworks.Add(new Microsoft.AspNetCore.HttpOverrides.IPNetwork(System.Net.IPAddress.Parse("0.0.0.0"), 0));
forwardedHeadersOptions.KnownNetworks.Add(new Microsoft.AspNetCore.HttpOverrides.IPNetwork(System.Net.IPAddress.IPv6Any, 0));
app.UseForwardedHeaders(forwardedHeadersOptions);

if (!app.Environment.IsDevelopment())
{
    app.UseHsts();
    // Defense in depth: Railway already terminates TLS at the edge and forces
    // HTTPS, but if the platform proxy is ever bypassed (direct container
    // exposure, sidecar, future migration) we want first-touch HTTP to redirect
    // rather than serve cleartext. Runs after UseForwardedHeaders so the scheme
    // check sees X-Forwarded-Proto correctly.
    app.UseHttpsRedirection();
}

app.UseCors("AllowFrontend");
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();

// Health check endpoint
app.MapGet("/api/health", () => Results.Ok(new { status = "healthy", timestamp = DateTime.UtcNow }));

app.MapControllers();
app.MapHub<WatchTogetherHub>("/hubs/watchtogether");

// Ensure MongoDB indexes exist before serving traffic. Idempotent on re-runs.
// Failing to create indexes is fatal — the unique constraints prevent duplicate-account
// races and the lookup indexes turn anonymous endpoints from O(n) into O(1).
using (var scope = app.Services.CreateScope())
{
    var mongoContext = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
    await mongoContext.EnsureIndexesAsync();
    // H7: backfill ActiveLinkCount on User docs that predate the atomic quota
    // counter. One-time work for existing users; new users get the field via
    // the entity default (0). Idempotent — safe on every restart.
    await mongoContext.BackfillActiveLinkCountsAsync();
}

app.Run();

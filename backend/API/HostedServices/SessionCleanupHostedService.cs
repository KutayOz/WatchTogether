using WatchTogether.Business.Services;

namespace WatchTogether.API.HostedServices;

/// <summary>
/// Drives periodic cleanup of expired sessions and invites independently of write traffic.
/// Previously, cleanup ran only inside CreateSession / GenerateInvite, so quiet periods
/// (overnight, low-use days) leaked entries indefinitely. On a 256 MB Fly machine that
/// pressure showed up as Kestrel heartbeat-starvation warnings ramping toward OOM.
/// </summary>
public class SessionCleanupHostedService : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(1);

    private readonly ISessionService _sessions;
    private readonly ILogger<SessionCleanupHostedService> _logger;

    public SessionCleanupHostedService(ISessionService sessions, ILogger<SessionCleanupHostedService> logger)
    {
        _sessions = sessions;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Wait one interval before the first run so we don't compete with app startup.
        try { await Task.Delay(Interval, stoppingToken); }
        catch (TaskCanceledException) { return; }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var sessionsRemoved = _sessions.RunSessionCleanup();
                var invitesRemoved = _sessions.RunInviteCleanup();

                // Only log when we actually freed something — keeps idle-period log volume zero.
                if (sessionsRemoved > 0 || invitesRemoved > 0)
                {
                    _logger.LogInformation(
                        "Cleanup pass: removed {Sessions} expired sessions, {Invites} expired invites",
                        sessionsRemoved, invitesRemoved);
                }
            }
            catch (Exception ex)
            {
                // Don't let a transient cleanup failure tear down the worker — log and keep cycling.
                _logger.LogError(ex, "Session cleanup pass failed; will retry next interval");
            }

            try { await Task.Delay(Interval, stoppingToken); }
            catch (TaskCanceledException) { return; }
        }
    }
}

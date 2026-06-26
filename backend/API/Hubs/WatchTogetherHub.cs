using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using WatchTogether.Business.DTOs;
using WatchTogether.Business.Services;

namespace WatchTogether.API.Hubs;

[Authorize]
public class WatchTogetherHub : Hub
{
    private readonly ISessionService _sessionService;
    private readonly ILogger<WatchTogetherHub> _logger;

    // Upper bounds on relayed payloads. The hub fans these out to the peer with no
    // persistence, but an authenticated peer could still push MB-scale strings to
    // pressure the relay / the other client. Caps are generous vs. real traffic
    // (SDP ~2-5 KB, ICE candidate ~300 B, chat a sentence) and only block abuse.
    private const int MaxSdpLength = 30_000;
    private const int MaxIceCandidateLength = 2_000;
    private const int MaxChatMessageLength = 5_000;

    public WatchTogetherHub(ISessionService sessionService, ILogger<WatchTogetherHub> logger)
    {
        _sessionService = sessionService;
        _logger = logger;
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var sessionId = GetSessionId();
        if (!string.IsNullOrEmpty(sessionId))
        {
            _sessionService.RemoveParticipant(sessionId, Context.ConnectionId);
            await Clients.OthersInGroup(sessionId).SendAsync("PeerLeft", GetDisplayName());
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, sessionId);
        }
        await base.OnDisconnectedAsync(exception);
    }

    // ──────────────────────────────────────────────────────────────────────
    // JoinSession is the only method that legitimately takes an arbitrary
    // sessionId from the client — it's the entry point. Every OTHER hub
    // method below guards via EnsureCallerInSession, which returns null when
    // the caller hasn't joined or claimed a different session than their
    // actual membership.
    //
    // Security context: before this guard, any authenticated user who knew
    // (or guessed) a session ID could inject SDP / chat / state into any
    // session — H1 in the audit. With H2 we also bumped session IDs from
    // 32-bit to 96-bit, so the "guessed" path is closed too.
    // ──────────────────────────────────────────────────────────────────────

    public async Task<bool> JoinSession(string sessionId)
    {
        var email = GetEmail();
        var displayName = GetDisplayName();
        var connectionId = Context.ConnectionId;

        _logger.LogDebug("JoinSession: session={SessionId} conn={ConnectionId}", sessionId, connectionId);

        // Explicit session existence check
        if (!_sessionService.SessionExists(sessionId))
        {
            _logger.LogDebug("Session {SessionId} does not exist", sessionId);
            return false;
        }

        // Get existing participants BEFORE adding the new one
        var existingParticipants = _sessionService.GetOtherParticipants(sessionId, connectionId);

        var added = _sessionService.AddParticipant(sessionId, connectionId, email, displayName);
        if (!added)
        {
            _logger.LogWarning("Failed to add participant to session {SessionId}", sessionId);
            return false;
        }

        Context.Items["sessionId"] = sessionId;
        await Groups.AddToGroupAsync(connectionId, sessionId);

        // Notify existing participants that a new peer joined
        await Clients.OthersInGroup(sessionId).SendAsync("PeerJoined", displayName);

        // Notify the joining user about existing participants (for peer name display)
        // Must come AFTER the OthersInGroup notification to avoid race conditions.
        // The joining user receives peer info but does NOT trigger WebRTC initiation.
        foreach (var participant in existingParticipants)
        {
            await Clients.Caller.SendAsync("ExistingPeer", participant.DisplayName);
        }

        return true;
    }

    public async Task LeaveSession(string sessionId)
    {
        // Use the actual session ID from Context.Items as the source of truth — the
        // client's parameter is informational only. Prevents a malicious client from
        // calling LeaveSession with someone else's session ID.
        var actualSessionId = GetSessionId();
        if (string.IsNullOrEmpty(actualSessionId)) return;

        _sessionService.RemoveParticipant(actualSessionId, Context.ConnectionId);
        await Clients.OthersInGroup(actualSessionId).SendAsync("PeerLeft", GetDisplayName());
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, actualSessionId);
        Context.Items.Remove("sessionId");
    }

    public async Task SendOffer(string sessionId, string sdpOffer)
    {
        if (EnsureCallerInSession(sessionId) is not string s) return;
        if (string.IsNullOrWhiteSpace(sdpOffer) || sdpOffer.Length > MaxSdpLength) return;
        await Clients.OthersInGroup(s).SendAsync("ReceiveOffer", sdpOffer, GetDisplayName());
    }

    public async Task SendAnswer(string sessionId, string sdpAnswer)
    {
        if (EnsureCallerInSession(sessionId) is not string s) return;
        if (string.IsNullOrWhiteSpace(sdpAnswer) || sdpAnswer.Length > MaxSdpLength) return;
        await Clients.OthersInGroup(s).SendAsync("ReceiveAnswer", sdpAnswer);
    }

    public async Task SendIceCandidate(string sessionId, string candidate)
    {
        if (EnsureCallerInSession(sessionId) is not string s) return;
        if (string.IsNullOrWhiteSpace(candidate) || candidate.Length > MaxIceCandidateLength) return;
        await Clients.OthersInGroup(s).SendAsync("ReceiveIceCandidate", candidate);
    }

    public async Task SendChatMessage(string sessionId, string message)
    {
        if (EnsureCallerInSession(sessionId) is not string s) return;
        if (string.IsNullOrWhiteSpace(message) || message.Length > MaxChatMessageLength) return;
        var chatMessage = new ChatMessage
        {
            Sender = GetDisplayName(),
            Message = message,
            Timestamp = DateTime.UtcNow
        };
        await Clients.Group(s).SendAsync("ReceiveChatMessage", chatMessage);
    }

    public async Task NotifyMediaStateChange(string sessionId, MediaState state)
    {
        if (EnsureCallerInSession(sessionId) is not string s) return;
        await Clients.OthersInGroup(s).SendAsync("PeerMediaStateChanged", GetDisplayName(), state);
    }

    /// <summary>
    /// Lightweight typing notification — peer sees "X is typing…" in chat.
    /// Fire-and-forget, no persistence, no acknowledgement. Frontend
    /// debounces sending (every 2-3 s while typing) and auto-clears the
    /// indicator after ~2 s of silence on the receive side.
    /// </summary>
    public async Task NotifyTyping(string sessionId)
    {
        if (EnsureCallerInSession(sessionId) is not string s) return;
        await Clients.OthersInGroup(s).SendAsync("PeerTyping", GetDisplayName());
    }

    /// <summary>
    /// "Watch Together" sync — peer-to-peer video co-watching. The frontend
    /// owns the player (YouTube iframe); this hub just relays state
    /// transitions so the other side mirrors them.
    ///
    /// `action` is one of: "load" | "play" | "pause" | "seek" | "close".
    /// `payload` is action-specific: load = YouTube URL, play/pause/seek =
    /// current timestamp in seconds (string). Last-action-wins on the
    /// receiver — no master/slave dance.
    /// </summary>
    public async Task NotifyVideoSync(string sessionId, string action, string payload)
    {
        if (EnsureCallerInSession(sessionId) is not string s) return;
        await Clients.OthersInGroup(s).SendAsync("PeerVideoSync", GetDisplayName(), action, payload);
    }

    /// <summary>
    /// Floating reactions (heart, laugh, fire, etc.). Lightweight — emoji
    /// codepoint as a string, peer renders a floating-up animation.
    /// Throttling is the frontend's job; this just relays.
    /// </summary>
    public async Task NotifyReaction(string sessionId, string emoji)
    {
        if (EnsureCallerInSession(sessionId) is not string s) return;
        await Clients.OthersInGroup(s).SendAsync("PeerReaction", GetDisplayName(), emoji);
    }

    /// <summary>
    /// Cursor position relayed during screen-share viewing — Figma multiplayer
    /// pattern. x/y are normalized (0..1) so the receiver can map onto its
    /// own screen-share container regardless of resolution. Throttled
    /// upstream by the frontend (~10 Hz).
    /// </summary>
    public async Task NotifyCursor(string sessionId, double x, double y)
    {
        if (EnsureCallerInSession(sessionId) is not string s) return;
        await Clients.OthersInGroup(s).SendAsync("PeerCursor", GetDisplayName(), x, y);
    }

    public async Task RequestScreenShare(string sessionId)
    {
        if (EnsureCallerInSession(sessionId) is not string s) return;
        await Clients.OthersInGroup(s).SendAsync("ScreenShareRequested", GetDisplayName());
    }

    public async Task RespondScreenShare(string sessionId, bool approved)
    {
        if (EnsureCallerInSession(sessionId) is not string s) return;
        await Clients.OthersInGroup(s).SendAsync("ScreenShareResponse", approved, GetDisplayName());
    }

    public async Task StopScreenShare(string sessionId)
    {
        if (EnsureCallerInSession(sessionId) is not string s) return;
        await Clients.OthersInGroup(s).SendAsync("ScreenShareStopped", GetDisplayName());
    }

    public async Task NotifyScreenShareStarted(string sessionId, string streamId)
    {
        if (EnsureCallerInSession(sessionId) is not string s) return;
        await Clients.OthersInGroup(s).SendAsync("ScreenShareStarted", GetDisplayName(), streamId);
    }

    // Renegotiation for screen share
    public async Task SendRenegotiationOffer(string sessionId, string sdpOffer)
    {
        if (EnsureCallerInSession(sessionId) is not string s) return;
        if (string.IsNullOrWhiteSpace(sdpOffer) || sdpOffer.Length > MaxSdpLength) return;
        await Clients.OthersInGroup(s).SendAsync("ReceiveRenegotiationOffer", sdpOffer);
    }

    public async Task SendRenegotiationAnswer(string sessionId, string sdpAnswer)
    {
        if (EnsureCallerInSession(sessionId) is not string s) return;
        if (string.IsNullOrWhiteSpace(sdpAnswer) || sdpAnswer.Length > MaxSdpLength) return;
        await Clients.OthersInGroup(s).SendAsync("ReceiveRenegotiationAnswer", sdpAnswer);
    }

    // Quality feedback from watcher to streamer
    public async Task SendQualityFeedback(string sessionId, QualityFeedback feedback)
    {
        if (EnsureCallerInSession(sessionId) is not string s) return;
        await Clients.OthersInGroup(s).SendAsync("ReceiveQualityFeedback", GetDisplayName(), feedback);
    }

    // ──────────────────────────────────────────────────────────────────────
    // Helpers
    // ──────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Defense-in-depth guard: returns the caller's actual session ID iff it
    /// matches the claimed one from the client parameter. Returns null (and logs)
    /// when the caller hasn't joined any session, or claims a different one than
    /// their actual membership.
    ///
    /// Policy on mismatch: silent reject. We deliberately don't throw HubException
    /// or disconnect — both would reveal session-state info to a probing attacker
    /// and break legitimate-but-buggy clients. The log is the operator's signal.
    /// </summary>
    private string? EnsureCallerInSession(string claimedSessionId)
    {
        var actualSessionId = GetSessionId();
        if (string.IsNullOrEmpty(actualSessionId))
        {
            _logger.LogWarning(
                "Hub call rejected: caller has not joined any session " +
                "(claimed={Claimed} conn={ConnectionId} user={User})",
                claimedSessionId, Context.ConnectionId, GetEmail());
            return null;
        }
        if (!string.Equals(actualSessionId, claimedSessionId, StringComparison.Ordinal))
        {
            _logger.LogWarning(
                "Hub call rejected: caller's actual session {Actual} doesn't match claimed {Claimed} " +
                "(conn={ConnectionId} user={User})",
                actualSessionId, claimedSessionId, Context.ConnectionId, GetEmail());
            return null;
        }
        return actualSessionId;
    }

    private string GetEmail()
    {
        return Context.User?.FindFirst(ClaimTypes.Email)?.Value ?? "unknown";
    }

    private string GetDisplayName()
    {
        return Context.User?.FindFirst(ClaimTypes.Name)?.Value ?? "Unknown";
    }

    private string? GetSessionId()
    {
        return Context.Items.TryGetValue("sessionId", out var sessionId) ? sessionId as string : null;
    }
}

using System.Net.Http;
using FluentAssertions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Moq;
using WatchTogether.Business.Services;

namespace WatchTogether.Tests;

/// <summary>
/// SessionService is an in-memory store guarded by per-session locks. These
/// tests cover the public contract end-to-end without touching MongoDB or the
/// SignalR hub — every behavior is observable through the public methods.
///
/// Time-sensitive paths (invite expiry, empty-session cleanup) are tested by
/// reflecting into the private dictionaries to backdate timestamps. That's
/// brittle in the sense that a refactor of the field names will break the
/// tests, but it lets us avoid a clock-abstraction refactor of the production
/// code for a single test concern. A proper IClock is on the someday list.
/// </summary>
public class SessionServiceTests
{
    private const string CreatorUserId = "creator-user-id";
    private const string OtherUserId = "other-user-id";
    private const string FrontendUrl = "https://example.test";

    // Each test gets a fresh service with no TURN configured — keeps the
    // CreateSession / AddParticipant tests pure. The TURN-specific tests
    // build their own configured instance.
    private static SessionService NewService(IConfiguration? config = null)
    {
        // The Cloudflare TURN branch is never exercised here (no Cloudflare config
        // set), so a bare mocked factory is enough — its CreateClient is never called.
        return new SessionService(config ?? EmptyConfig(), Mock.Of<IHttpClientFactory>(), Mock.Of<ILogger<SessionService>>());
    }

    private static IConfiguration EmptyConfig() =>
        new ConfigurationBuilder().AddInMemoryCollection().Build();

    // ──────────────────────────────────────────────────────────────────
    // CreateSession + GetSession + SessionExists
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public void CreateSession_returns_id_and_persists_session()
    {
        var svc = NewService();

        var id = svc.CreateSession(CreatorUserId);

        id.Should().NotBeNullOrWhiteSpace();
        svc.SessionExists(id).Should().BeTrue();
        svc.GetSession(id)!.CreatorUserId.Should().Be(CreatorUserId);
    }

    [Fact]
    public void CreateSession_returns_unique_ids_across_calls()
    {
        // 96-bit random IDs are mathematically collision-free at this volume,
        // but the test still belts-and-braces — a regression that introduced
        // sequential IDs would silently pass everything else.
        var svc = NewService();

        var ids = Enumerable.Range(0, 50)
            .Select(_ => svc.CreateSession(CreatorUserId))
            .ToList();

        ids.Should().OnlyHaveUniqueItems();
    }

    [Fact]
    public void GetSession_returns_null_for_unknown_id()
    {
        var svc = NewService();
        svc.GetSession("nope").Should().BeNull();
        svc.SessionExists("nope").Should().BeFalse();
    }

    // ──────────────────────────────────────────────────────────────────
    // AddParticipant — the 2-person cap is the load-bearing invariant
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public void AddParticipant_fails_when_session_does_not_exist()
    {
        var svc = NewService();
        svc.AddParticipant("nope", "conn-1", "a@b.test", "A").Should().BeFalse();
    }

    [Fact]
    public void AddParticipant_admits_first_two_and_rejects_third()
    {
        var svc = NewService();
        var id = svc.CreateSession(CreatorUserId);

        svc.AddParticipant(id, "conn-1", "a@b.test", "A").Should().BeTrue();
        svc.AddParticipant(id, "conn-2", "b@b.test", "B").Should().BeTrue();
        // Third participant trying to join MUST be rejected — this is the
        // entire reason the cap exists (TURN credits, WebRTC mesh complexity).
        svc.AddParticipant(id, "conn-3", "c@b.test", "C").Should().BeFalse();

        svc.GetParticipantCount(id).Should().Be(2);
    }

    [Fact]
    public void AddParticipant_is_idempotent_for_same_connectionId()
    {
        // Reconnect path: SignalR client may re-invoke JoinSession on a flaky
        // network. Same ConnectionId joining twice must NOT count as two seats
        // (or partner would get locked out after a single disconnect).
        var svc = NewService();
        var id = svc.CreateSession(CreatorUserId);

        svc.AddParticipant(id, "conn-1", "a@b.test", "A").Should().BeTrue();
        svc.AddParticipant(id, "conn-1", "a@b.test", "A").Should().BeTrue();

        svc.GetParticipantCount(id).Should().Be(1);
    }

    // ──────────────────────────────────────────────────────────────────
    // RemoveParticipant + EmptySince grace period
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public void RemoveParticipant_removes_by_connectionId()
    {
        var svc = NewService();
        var id = svc.CreateSession(CreatorUserId);
        svc.AddParticipant(id, "conn-1", "a@b.test", "A");
        svc.AddParticipant(id, "conn-2", "b@b.test", "B");

        svc.RemoveParticipant(id, "conn-1");

        var others = svc.GetOtherParticipants(id, "ignored");
        others.Should().ContainSingle(p => p.ConnectionId == "conn-2");
        svc.GetParticipantCount(id).Should().Be(1);
    }

    [Fact]
    public void RemoveParticipant_marks_EmptySince_when_room_empties()
    {
        // The grace period is the entire point of the "soft delete" model —
        // a brief disconnect shouldn't kill the room. The marker is what the
        // background cleanup looks at.
        var svc = NewService();
        var id = svc.CreateSession(CreatorUserId);
        svc.AddParticipant(id, "conn-1", "a@b.test", "A");

        var before = DateTime.UtcNow;
        svc.RemoveParticipant(id, "conn-1");
        var after = DateTime.UtcNow;

        var session = svc.GetSession(id)!;
        session.EmptySince.Should().NotBeNull();
        session.EmptySince!.Value.Should().BeOnOrAfter(before).And.BeOnOrBefore(after);
    }

    [Fact]
    public void AddParticipant_clears_EmptySince_when_room_refills()
    {
        // Inverse of the above: rejoining after a brief absence shouldn't
        // leave the cleanup background service primed to nuke the room.
        var svc = NewService();
        var id = svc.CreateSession(CreatorUserId);
        svc.AddParticipant(id, "conn-1", "a@b.test", "A");
        svc.RemoveParticipant(id, "conn-1");

        svc.GetSession(id)!.EmptySince.Should().NotBeNull("just emptied");

        svc.AddParticipant(id, "conn-2", "b@b.test", "B");

        svc.GetSession(id)!.EmptySince.Should().BeNull("room is occupied again");
    }

    [Fact]
    public void RunSessionCleanup_removes_only_sessions_emptied_past_grace_period()
    {
        // Backdate the EmptySince marker on one session to before the cutoff;
        // leave another in a fresh "just emptied" state. Only the old one
        // should be removed.
        var svc = NewService();
        var oldId = svc.CreateSession(CreatorUserId);
        svc.AddParticipant(oldId, "conn-a", "a@b.test", "A");
        svc.RemoveParticipant(oldId, "conn-a");

        var freshId = svc.CreateSession(OtherUserId);
        svc.AddParticipant(freshId, "conn-b", "b@b.test", "B");
        svc.RemoveParticipant(freshId, "conn-b");

        // Backdate EmptySince on the "old" session to 10 minutes ago, past
        // the 5-minute grace period.
        var oldSession = svc.GetSession(oldId)!;
        oldSession.EmptySince = DateTime.UtcNow.AddMinutes(-10);

        var removed = svc.RunSessionCleanup();

        removed.Should().Be(1);
        svc.SessionExists(oldId).Should().BeFalse("past grace period");
        svc.SessionExists(freshId).Should().BeTrue("still within grace period");
    }

    // ──────────────────────────────────────────────────────────────────
    // GenerateInvite — ownership + cap checks
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public void GenerateInvite_fails_when_session_does_not_exist()
    {
        var svc = NewService();
        var result = svc.GenerateInvite("nope", CreatorUserId, FrontendUrl);

        result.Success.Should().BeFalse();
        result.Message.Should().Contain("does not exist");
    }

    [Fact]
    public void GenerateInvite_fails_when_caller_is_not_session_creator()
    {
        // IDOR defense: an authenticated user who knows another user's
        // sessionId must not be able to mint invites that grant access.
        var svc = NewService();
        var id = svc.CreateSession(CreatorUserId);

        var result = svc.GenerateInvite(id, OtherUserId, FrontendUrl);

        result.Success.Should().BeFalse();
        result.Message.Should().Contain("not the creator");
    }

    [Fact]
    public void GenerateInvite_fails_when_session_is_full()
    {
        var svc = NewService();
        var id = svc.CreateSession(CreatorUserId);
        svc.AddParticipant(id, "conn-1", "a@b.test", "A");
        svc.AddParticipant(id, "conn-2", "b@b.test", "B");

        var result = svc.GenerateInvite(id, CreatorUserId, FrontendUrl);

        result.Success.Should().BeFalse();
        result.Message.Should().Contain("full");
    }

    [Fact]
    public void GenerateInvite_returns_existing_active_invite_instead_of_minting_a_new_one()
    {
        // Two clicks of "copy invite link" within the 15-min window should
        // return the SAME URL — otherwise we'd accumulate dead invites and
        // the peer might end up holding a token the host re-issued away from.
        var svc = NewService();
        var id = svc.CreateSession(CreatorUserId);

        var first = svc.GenerateInvite(id, CreatorUserId, FrontendUrl);
        var second = svc.GenerateInvite(id, CreatorUserId, FrontendUrl);

        first.Success.Should().BeTrue();
        second.Success.Should().BeTrue();
        second.Token.Should().Be(first.Token);
        second.InviteUrl.Should().Be(first.InviteUrl);
    }

    [Fact]
    public void GenerateInvite_includes_frontendUrl_and_expiry_in_response()
    {
        var svc = NewService();
        var id = svc.CreateSession(CreatorUserId);

        var before = DateTime.UtcNow;
        var result = svc.GenerateInvite(id, CreatorUserId, FrontendUrl);

        result.Success.Should().BeTrue();
        result.InviteUrl.Should().StartWith($"{FrontendUrl}/join/");
        // Expiry should land roughly 15 minutes in the future.
        result.ExpiresAt.Should().BeAfter(before.AddMinutes(14)).And.BeBefore(before.AddMinutes(16));
    }

    // ──────────────────────────────────────────────────────────────────
    // ValidateInvite — every failure mode
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public void ValidateInvite_fails_for_unknown_token()
    {
        var svc = NewService();
        svc.ValidateInvite("nonexistent").Valid.Should().BeFalse();
    }

    [Fact]
    public void ValidateInvite_fails_after_MarkInviteUsed()
    {
        var svc = NewService();
        var id = svc.CreateSession(CreatorUserId);
        var invite = svc.GenerateInvite(id, CreatorUserId, FrontendUrl);

        svc.MarkInviteUsed(invite.Token!, OtherUserId).Should().BeTrue();
        var validation = svc.ValidateInvite(invite.Token!);

        validation.Valid.Should().BeFalse();
        validation.Message.Should().Contain("already been used");
    }

    [Fact]
    public void ValidateInvite_fails_when_session_no_longer_exists()
    {
        // Issued invite, then session cleaned up under our feet.
        var svc = NewService();
        var id = svc.CreateSession(CreatorUserId);
        var invite = svc.GenerateInvite(id, CreatorUserId, FrontendUrl);

        // Force-remove the session via the public cleanup path: empty it,
        // backdate, then run cleanup.
        svc.AddParticipant(id, "conn-1", "a@b.test", "A");
        svc.RemoveParticipant(id, "conn-1");
        svc.GetSession(id)!.EmptySince = DateTime.UtcNow.AddMinutes(-10);
        svc.RunSessionCleanup();

        svc.ValidateInvite(invite.Token!).Valid.Should().BeFalse();
    }

    [Fact]
    public void ValidateInvite_fails_when_session_is_full()
    {
        // Edge case the docs call out: invite generated when session had room,
        // peer takes their time, second user joins through a different path,
        // now the invitee shows up to a full room.
        var svc = NewService();
        var id = svc.CreateSession(CreatorUserId);
        var invite = svc.GenerateInvite(id, CreatorUserId, FrontendUrl);

        svc.AddParticipant(id, "conn-1", "a@b.test", "A");
        svc.AddParticipant(id, "conn-2", "b@b.test", "B");

        var result = svc.ValidateInvite(invite.Token!);
        result.Valid.Should().BeFalse();
        result.Message.Should().Contain("full");
    }

    [Fact]
    public void ValidateInvite_succeeds_for_fresh_invite_and_returns_creator_displayName()
    {
        var svc = NewService();
        var id = svc.CreateSession(CreatorUserId);
        svc.AddParticipant(id, "conn-1", "a@b.test", "Alice");
        var invite = svc.GenerateInvite(id, CreatorUserId, FrontendUrl);

        var result = svc.ValidateInvite(invite.Token!);

        result.Valid.Should().BeTrue();
        result.SessionId.Should().Be(id);
        result.CreatorDisplayName.Should().Be("Alice");
    }

    // ──────────────────────────────────────────────────────────────────
    // MarkInviteUsed — atomic single-use semantics
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public void MarkInviteUsed_returns_true_only_on_first_call_and_false_thereafter()
    {
        // TOCTOU defense — the comment in the production code calls this out
        // explicitly: an earlier version had ValidateInvite returning Valid=true
        // for two concurrent callers and both then succeeded at "marking used".
        // The Interlocked.CompareExchange flip means only one wins.
        var svc = NewService();
        var id = svc.CreateSession(CreatorUserId);
        var invite = svc.GenerateInvite(id, CreatorUserId, FrontendUrl);

        svc.MarkInviteUsed(invite.Token!, OtherUserId).Should().BeTrue();
        svc.MarkInviteUsed(invite.Token!, OtherUserId).Should().BeFalse();
        svc.MarkInviteUsed(invite.Token!, "third-user").Should().BeFalse();
    }

    [Fact]
    public void MarkInviteUsed_returns_false_for_unknown_token()
    {
        var svc = NewService();
        svc.MarkInviteUsed("nonexistent", OtherUserId).Should().BeFalse();
    }

    // ──────────────────────────────────────────────────────────────────
    // GetIceServers — STUN, static TURN, time-bound TURN
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public async Task GetIceServers_returns_only_STUN_when_no_TURN_configured()
    {
        var svc = NewService();
        var config = await svc.GetIceServersAsync(CreatorUserId);

        config.IceServers.Should().OnlyContain(s => s.Urls.StartsWith("stun:"));
        config.IceServers.Should().HaveCount(2, "two Google STUN endpoints");
    }

    [Fact]
    public async Task GetIceServers_includes_static_TURN_credentials_when_configured_without_auth_secret()
    {
        // Legacy path — TurnUsername/TurnCredential set directly. Same creds
        // returned to everyone, no expiry. Cheap but a credential leak is
        // forever.
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["WebRTC:TurnServer"] = "turn.example.com",
                ["WebRTC:TurnUsername"] = "static-user",
                ["WebRTC:TurnCredential"] = "static-secret",
            })
            .Build();

        var svc = NewService(config);
        var iceConfig = await svc.GetIceServersAsync(CreatorUserId);

        var turnEntries = iceConfig.IceServers.Where(s => s.Urls.StartsWith("turn:") || s.Urls.StartsWith("turns:")).ToList();
        turnEntries.Should().NotBeEmpty();
        turnEntries.Should().OnlyContain(s => s.Username == "static-user" && s.Credential == "static-secret");
    }

    [Fact]
    public async Task GetIceServers_mints_time_bound_TURN_credentials_when_auth_secret_is_set()
    {
        // coturn `use-auth-secret` mode. Each user gets a fresh expiry baked
        // into the username. Two different userIds should produce different
        // usernames (since both encode the userId).
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["WebRTC:TurnServer"] = "turn.example.com",
                ["WebRTC:TurnAuthSecret"] = "shared-secret",
                ["WebRTC:TurnCredentialTtlSeconds"] = "3600",
            })
            .Build();

        var svc = NewService(config);
        var alice = await svc.GetIceServersAsync("alice");
        var bob = await svc.GetIceServersAsync("bob");

        var aliceTurn = alice.IceServers.First(s => s.Urls.StartsWith("turn:"));
        var bobTurn = bob.IceServers.First(s => s.Urls.StartsWith("turn:"));

        // coturn spec: username = "{unixExpiry}:{userId}"
        aliceTurn.Username.Should().EndWith(":alice");
        bobTurn.Username.Should().EndWith(":bob");
        aliceTurn.Username.Should().NotBe(bobTurn.Username, "encode different userIds");
        aliceTurn.Credential.Should().NotBeNullOrEmpty("HMAC over the username");
        aliceTurn.Credential.Should().NotBe(bobTurn.Credential, "different usernames hash differently");
    }

    [Fact]
    public async Task GetIceServers_omits_TURN_when_URL_is_set_but_credentials_are_missing()
    {
        // Half-configured deployment — URL but no username/credential and no
        // auth secret. Should degrade to STUN-only rather than emitting a
        // broken TURN entry.
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["WebRTC:TurnServer"] = "turn.example.com",
            })
            .Build();

        var svc = NewService(config);
        var iceConfig = await svc.GetIceServersAsync(CreatorUserId);

        iceConfig.IceServers.Should().OnlyContain(s => s.Urls.StartsWith("stun:"));
    }

    // ──────────────────────────────────────────────────────────────────
    // GetOtherParticipants — peer-discovery helper used by the hub
    // ──────────────────────────────────────────────────────────────────

    [Fact]
    public void GetOtherParticipants_excludes_the_calling_connectionId()
    {
        var svc = NewService();
        var id = svc.CreateSession(CreatorUserId);
        svc.AddParticipant(id, "conn-1", "a@b.test", "A");
        svc.AddParticipant(id, "conn-2", "b@b.test", "B");

        var others = svc.GetOtherParticipants(id, "conn-1");

        others.Should().ContainSingle(p => p.ConnectionId == "conn-2");
    }

    [Fact]
    public void GetOtherParticipants_returns_empty_list_for_unknown_session()
    {
        var svc = NewService();
        svc.GetOtherParticipants("nope", "any-conn").Should().BeEmpty();
    }
}

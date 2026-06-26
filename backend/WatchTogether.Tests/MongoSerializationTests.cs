using FluentAssertions;
using MongoDB.Bson;
using WatchTogether.Data.Entities;

namespace WatchTogether.Tests;

public class MongoSerializationTests
{
    [Fact]
    public void User_omits_null_fields_backing_sparse_unique_indexes()
    {
        var user = new User
        {
            Id = ObjectId.GenerateNewId().ToString(),
            Email = "ahmetkutaykutay@outlook.com",
            DisplayName = "Ahmet",
            PasswordHash = "hash",
            IsEmailVerified = true,
        };

        var document = user.ToBsonDocument();

        document.Contains("googleId").Should().BeFalse();
        document.Contains("emailVerificationTokenLookup").Should().BeFalse();
    }

    [Fact]
    public void User_still_serializes_non_null_sparse_unique_fields()
    {
        var user = new User
        {
            Id = ObjectId.GenerateNewId().ToString(),
            Email = "ahmetkutaykutay@outlook.com",
            DisplayName = "Ahmet",
            GoogleId = "google-subject",
            EmailVerificationTokenLookup = "TOKEN_LOOKUP",
            IsEmailVerified = true,
        };

        var document = user.ToBsonDocument();

        document["googleId"].AsString.Should().Be("google-subject");
        document["emailVerificationTokenLookup"].AsString.Should().Be("TOKEN_LOOKUP");
    }

    [Fact]
    public void Invitation_omits_null_token_lookup()
    {
        var invitation = new Invitation
        {
            Id = ObjectId.GenerateNewId().ToString(),
            InviterUserId = ObjectId.GenerateNewId().ToString(),
            InviteeEmail = "ahmetkutaykutay@outlook.com",
            InvitationToken = "token-hash",
            ExpiresAt = DateTime.UtcNow.AddDays(1),
        };

        var document = invitation.ToBsonDocument();

        document.Contains("tokenLookup").Should().BeFalse();
    }

    [Fact]
    public void InvitationLink_omits_null_token_lookup()
    {
        var link = new InvitationLink
        {
            Id = ObjectId.GenerateNewId().ToString(),
            TokenHash = "token-hash",
            InviterUserId = ObjectId.GenerateNewId().ToString(),
            ExpiresAt = DateTime.UtcNow.AddHours(48),
        };

        var document = link.ToBsonDocument();

        document.Contains("tokenLookup").Should().BeFalse();
    }
}

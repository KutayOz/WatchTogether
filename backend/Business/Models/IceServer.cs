using System.Text.Json.Serialization;

namespace WatchTogether.Business.Models;

public class IceServer
{
    [JsonPropertyName("urls")]
    public string Urls { get; set; } = null!;

    [JsonPropertyName("username")]
    public string? Username { get; set; }

    [JsonPropertyName("credential")]
    public string? Credential { get; set; }
}

public class IceServerConfig
{
    [JsonPropertyName("iceServers")]
    public List<IceServer> IceServers { get; set; } = new();
}

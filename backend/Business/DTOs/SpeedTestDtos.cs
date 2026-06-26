namespace WatchTogether.Business.DTOs;

public class SpeedTestRequest
{
    public byte[] Payload { get; set; } = Array.Empty<byte>();
    public long ClientTimestamp { get; set; }
}

public class SpeedTestResponse
{
    public double UploadSpeedMbps { get; set; }
    public string RecommendedQuality { get; set; } = "auto";
    public Dictionary<string, bool> SupportedQualities { get; set; } = new();
    public long ServerTimestamp { get; set; }
}

public class QualityFeedback
{
    public string Level { get; set; } = "good";
    public int Score { get; set; }
    public double PacketLossPercent { get; set; }
    public double JitterMs { get; set; }
    public double RttMs { get; set; }
    public double Fps { get; set; }
}

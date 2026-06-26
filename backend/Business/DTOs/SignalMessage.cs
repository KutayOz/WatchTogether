namespace WatchTogether.Business.DTOs;

public class SignalMessage
{
    public string Type { get; set; } = null!;
    public string Data { get; set; } = null!;
}

public class MediaState
{
    public bool IsMuted { get; set; }
    public bool IsCameraOn { get; set; }
    public bool IsScreenSharing { get; set; }
}

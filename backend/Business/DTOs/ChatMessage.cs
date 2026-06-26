namespace WatchTogether.Business.DTOs;

public class ChatMessage
{
    public string Sender { get; set; } = null!;
    public string Message { get; set; } = null!;
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;
}

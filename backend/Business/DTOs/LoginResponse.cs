namespace WatchTogether.Business.DTOs;

public class LoginResponse
{
    public string Token { get; set; } = null!;
    public string DisplayName { get; set; } = null!;
    public string Email { get; set; } = null!;
}

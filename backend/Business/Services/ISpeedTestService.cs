using WatchTogether.Business.DTOs;

namespace WatchTogether.Business.Services;

public interface ISpeedTestService
{
    SpeedTestResponse CalculateSpeed(int payloadSizeBytes, double uploadTimeMs);
}

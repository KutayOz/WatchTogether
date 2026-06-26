using WatchTogether.Business.DTOs;

namespace WatchTogether.Business.Services;

public class SpeedTestService : ISpeedTestService
{
    // Quality thresholds in Mbps (with overhead buffer)
    private static readonly Dictionary<string, double> QualityThresholds = new()
    {
        { "extreme", 30.0 },  // 28 Mbps + overhead
        { "ultra", 18.0 },    // 15 Mbps + overhead
        { "high", 10.0 },     // 8 Mbps + overhead
        { "medium", 5.0 },    // 4 Mbps + overhead
        { "low", 2.0 },       // 1.5 Mbps + overhead
    };

    public SpeedTestResponse CalculateSpeed(int payloadSizeBytes, double uploadTimeMs)
    {
        // Prevent division by zero
        if (uploadTimeMs <= 0)
        {
            uploadTimeMs = 1;
        }

        // Calculate upload speed in Mbps
        // Formula: (bytes * 8 bits) / (milliseconds * 1000) = Mbps
        var speedMbps = (payloadSizeBytes * 8.0) / (uploadTimeMs * 1000.0);

        // Determine recommended quality based on speed
        var recommended = "auto";
        foreach (var (quality, threshold) in QualityThresholds.OrderByDescending(x => x.Value))
        {
            if (speedMbps >= threshold)
            {
                recommended = quality;
                break;
            }
        }

        // Build supported qualities map
        var supported = new Dictionary<string, bool>
        {
            { "auto", true }  // Always supported
        };

        foreach (var (quality, threshold) in QualityThresholds)
        {
            supported[quality] = speedMbps >= threshold;
        }

        return new SpeedTestResponse
        {
            UploadSpeedMbps = Math.Round(speedMbps, 2),
            RecommendedQuality = recommended,
            SupportedQualities = supported,
            ServerTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        };
    }
}

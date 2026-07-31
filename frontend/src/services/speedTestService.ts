import { API_URL } from '../utils/constants';
import { apiError, readJson } from './http';
import type { SpeedTestResult, ScreenShareQuality } from '../types';

const PAYLOAD_SIZE = 256 * 1024; // 256KB (reduced for reliability)
const CHUNK_SIZE = 65536; // 64KB - max for crypto.getRandomValues

// What POST /api/speedtest/upload returns on success (SpeedTestResponse
// server-side). As in api.ts this is an assertion about the contract, not a
// validated shape — readJson only guarantees the body parsed as JSON.
interface SpeedTestUploadResponse {
  uploadSpeedMbps: number;
  recommendedQuality: string;
  supportedQualities: Record<string, boolean>;
}

export const speedTestService = {
  async runTest(): Promise<SpeedTestResult> {
    // Generate random payload in chunks (crypto.getRandomValues has 64KB limit)
    const payload = new Uint8Array(PAYLOAD_SIZE);
    for (let offset = 0; offset < PAYLOAD_SIZE; offset += CHUNK_SIZE) {
      const chunk = new Uint8Array(payload.buffer, offset, Math.min(CHUNK_SIZE, PAYLOAD_SIZE - offset));
      crypto.getRandomValues(chunk);
    }

    const clientTimestamp = Date.now();
    const startTime = performance.now();

    // Auth is via HttpOnly cookie — same pattern as api.ts. credentials:'include'
    // ensures the cookie is sent on this POST.
    const response = await fetch(`${API_URL}/api/speedtest/upload`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Payload-Size': PAYLOAD_SIZE.toString(),
        'X-Client-Timestamp': clientTimestamp.toString(),
      },
      body: payload,
    });

    const endTime = performance.now();

    // This endpoint is unusually exposed to non-JSON bodies on both sides: it
    // POSTs 256KB against a 512KB [RequestSizeLimit], so a proxy with a
    // stricter cap rejects it with its own HTML 413 before the API ever runs.
    if (!response.ok) {
      throw await apiError(response, 'Speed test failed');
    }

    const result = await readJson<SpeedTestUploadResponse>(response, 'Speed test failed');

    // Calculate client-side speed as fallback/verification
    const durationSec = (endTime - startTime) / 1000;
    const clientSpeedMbps = (PAYLOAD_SIZE * 8) / (durationSec * 1_000_000);

    return {
      uploadSpeedMbps: result.uploadSpeedMbps || clientSpeedMbps,
      recommendedQuality: result.recommendedQuality as ScreenShareQuality,
      supportedQualities: result.supportedQualities,
      timestamp: Date.now(),
    };
  },
};

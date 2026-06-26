import { logger } from '../services/logger';
import { useState, useCallback, useEffect, useRef } from 'react';
import { speedTestService } from '../services/speedTestService';
import type { SpeedTestResult } from '../types';

const TEST_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export function useSpeedTest(autoStart = false) {
  const [result, setResult] = useState<SpeedTestResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRunningRef = useRef(false);

  const runTest = useCallback(async () => {
    if (isRunningRef.current) return null;

    isRunningRef.current = true;
    setIsRunning(true);
    setError(null);

    try {
      const testResult = await speedTestService.runTest();
      setResult(testResult);
      return testResult;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Speed test failed';
      setError(errorMessage);
      logger.error('[SpeedTest] Error:', errorMessage);
      return null;
    } finally {
      isRunningRef.current = false;
      setIsRunning(false);
    }
  }, []);

  const startPeriodicTests = useCallback(() => {
    if (intervalRef.current) return;

    // Run immediately, then every 5 minutes
    runTest();
    intervalRef.current = setInterval(runTest, TEST_INTERVAL_MS);
  }, [runTest]);

  const stopPeriodicTests = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (autoStart) {
      startPeriodicTests();
    }
    return () => stopPeriodicTests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  return {
    result,
    isRunning,
    error,
    runTest,
    startPeriodicTests,
    stopPeriodicTests,
  };
}

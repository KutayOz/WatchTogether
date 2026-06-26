import { useState, useCallback } from 'react';

export function useMediaDevices() {
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(true);

  const toggleMute = useCallback((toggleFn: (enabled: boolean) => void) => {
    setIsMuted(prev => {
      const newValue = !prev;
      toggleFn(!newValue);
      return newValue;
    });
  }, []);

  const toggleCamera = useCallback((toggleFn: (enabled: boolean) => void) => {
    setIsCameraOn(prev => {
      const newValue = !prev;
      toggleFn(newValue);
      return newValue;
    });
  }, []);

  return {
    isMuted,
    isCameraOn,
    toggleMute,
    toggleCamera,
  };
}

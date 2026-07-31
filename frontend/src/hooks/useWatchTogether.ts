import { type RefObject, useState, useRef, useCallback } from 'react';
import { extractYouTubeVideoId, type WatchTogetherPlayerHandle } from '../components/Session/WatchTogetherPlayer';

type ShowToast = (toast: { message: string; type: 'info' | 'error' | 'warning' }) => void;
type VideoSyncSender = { notifyVideoSync: (sessionId: string, action: string, payload: string) => void };

/**
 * "Watch Together" co-watch state + the local→peer sync senders. The frontend
 * owns the YouTube player (through watchPlayerRef); these handlers relay
 * load/close/play/pause/seek transitions. The RECEIVE side stays in
 * SessionRoom's central transport handler — it writes setWatchVideoId and drives
 * watchPlayerRef, so this hook is called before useTransport and sends through
 * transportRef (populated once the connection is wired).
 */
export function useWatchTogether(
  sessionIdRef: RefObject<string | null>,
  transportRef: RefObject<VideoSyncSender | null>,
  showToast: ShowToast,
) {
  const [watchVideoId, setWatchVideoId] = useState<string | null>(null);
  const [showWatchPrompt, setShowWatchPrompt] = useState(false);
  const watchPlayerRef = useRef<WatchTogetherPlayerHandle | null>(null);

  const handleStartWatch = useCallback((rawUrl: string) => {
    const id = extractYouTubeVideoId(rawUrl);
    if (!id) {
      showToast({ message: "couldn't read that — paste a YouTube link?", type: 'warning' });
      return;
    }
    setWatchVideoId(id);
    setShowWatchPrompt(false);
    if (sessionIdRef.current) {
      // Send the bare ID — accepted by extractYouTubeVideoId on the peer side too.
      transportRef.current?.notifyVideoSync(sessionIdRef.current, 'load', id);
    }
  }, [sessionIdRef, transportRef, showToast]);

  const handleCloseWatch = useCallback(() => {
    setWatchVideoId(null);
    if (sessionIdRef.current) {
      transportRef.current?.notifyVideoSync(sessionIdRef.current, 'close', '');
    }
  }, [sessionIdRef, transportRef]);

  const handleLocalVideoAction = useCallback(
    (action: 'play' | 'pause' | 'seek', payloadSeconds: number) => {
      if (sessionIdRef.current) {
        transportRef.current?.notifyVideoSync(sessionIdRef.current, action, String(payloadSeconds));
      }
    },
    [sessionIdRef, transportRef],
  );

  return {
    watchVideoId,
    setWatchVideoId,
    showWatchPrompt,
    setShowWatchPrompt,
    watchPlayerRef,
    handleStartWatch,
    handleCloseWatch,
    handleLocalVideoAction,
  };
}

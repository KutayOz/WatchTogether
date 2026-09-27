import { logger } from '../../services/logger';
import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { IconButton } from '../ui/Button';
import { CloseIcon, PlayIcon } from '../ui/icons';

export interface WatchTogetherPlayerHandle {
  /** Apply a remote peer's command without re-broadcasting (avoids ping-pong). */
  applyRemoteAction(action: 'play' | 'pause' | 'seek', payloadSeconds: number): void;
}

interface WatchTogetherPlayerProps {
  /** YouTube video ID (extracted from URL upstream). */
  videoId: string;
  peerDisplayName: string | null;
  /** Local user pressed play/pause/seeked — broadcast to peer. */
  onLocalAction: (action: 'play' | 'pause' | 'seek', payloadSeconds: number) => void;
  /** Close button pressed — caller clears the watch-mode state. */
  onClose: () => void;
}

/**
 * YouTube co-watching player. The iframe API is JS-bridge based: we
 * load https://www.youtube.com/iframe_api once, instantiate a YT.Player
 * bound to our <div>, and listen to its `onStateChange` events.
 *
 * Local control flow:
 *   User clicks play/pause inside the iframe → onStateChange fires →
 *   we read the current time and emit onLocalAction → parent sends via
 *   SignalR. Remote peer mirrors the action.
 *
 * Remote control flow:
 *   Parent receives PeerVideoSync from SignalR → calls
 *   applyRemoteAction() on this component's ref → we call player.playVideo()
 *   / pauseVideo() / seekTo() WITHOUT triggering onLocalAction (the
 *   `isRemoteActionRef` flag suppresses the broadcast).
 *
 * Without the suppress flag the two clients would ping-pong forever:
 * A plays → B mirrors → B's onStateChange fires → broadcasts to A → repeat.
 */

declare global {
  interface Window {
    YT?: {
      Player: new (
        el: HTMLElement | string,
        opts: {
          videoId: string;
          width?: string | number;
          height?: string | number;
          playerVars?: Record<string, unknown>;
          events?: {
            onReady?: (e: { target: YTPlayer }) => void;
            onStateChange?: (e: { data: number; target: YTPlayer }) => void;
          };
        }
      ) => YTPlayer;
      PlayerState: {
        UNSTARTED: -1;
        ENDED: 0;
        PLAYING: 1;
        PAUSED: 2;
        BUFFERING: 3;
        CUED: 5;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  destroy(): void;
}

let apiPromise: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    if (window.YT?.Player) {
      resolve();
      return;
    }
    const existing = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      existing?.();
      resolve();
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    document.head.appendChild(script);
  });
  return apiPromise;
}

export const WatchTogetherPlayer = forwardRef<WatchTogetherPlayerHandle, WatchTogetherPlayerProps>(
  function WatchTogetherPlayer({ videoId, peerDisplayName, onLocalAction, onClose }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const playerRef = useRef<YTPlayer | null>(null);
    // Flips true for one tick whenever we apply a remote action, so the
    // ensuing onStateChange event is identified as "not ours" and not
    // re-broadcast.
    const isRemoteActionRef = useRef(false);
    const [isReady, setIsReady] = useState(false);

    useEffect(() => {
      let cancelled = false;
      loadYouTubeApi().then(() => {
        if (cancelled || !containerRef.current || !window.YT) return;
        playerRef.current = new window.YT.Player(containerRef.current, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: {
            // Hide the YouTube-branded "watch more" suggestions at the
            // end of the video — keeps the experience inside our app.
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            // origin helps YouTube validate the postMessage target.
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              if (!cancelled) setIsReady(true);
            },
            onStateChange: (e) => {
              const state = e.data;
              const PlayerState = window.YT?.PlayerState;
              if (!PlayerState) return;
              // Skip broadcasting if THIS state change was triggered by a
              // remote action we just applied — otherwise both clients
              // ping-pong forever.
              if (isRemoteActionRef.current) {
                isRemoteActionRef.current = false;
                return;
              }
              const t = e.target.getCurrentTime();
              if (state === PlayerState.PLAYING) {
                onLocalAction('play', t);
              } else if (state === PlayerState.PAUSED) {
                onLocalAction('pause', t);
              }
            },
          },
        });
      });

      return () => {
        cancelled = true;
        try { playerRef.current?.destroy(); } catch { /* ignore */ }
        playerRef.current = null;
      };
      // videoId in deps so loading a new URL replaces the player.
    }, [videoId, onLocalAction]);

    useImperativeHandle(ref, () => ({
      applyRemoteAction(action, payloadSeconds) {
        const player = playerRef.current;
        if (!player || !window.YT) return;
        isRemoteActionRef.current = true;
        try {
          if (action === 'play') {
            // If we're too far out of sync (>1s drift), snap to peer's
            // position before resuming. Tight tolerance because a small
            // drift accumulates fast across pause/play cycles.
            const local = player.getCurrentTime();
            if (Math.abs(local - payloadSeconds) > 1) {
              player.seekTo(payloadSeconds, true);
            }
            player.playVideo();
          } else if (action === 'pause') {
            player.pauseVideo();
          } else if (action === 'seek') {
            player.seekTo(payloadSeconds, true);
          }
        } catch (err) {
          logger.warn('[WatchTogether] remote action failed:', err);
        }
      },
    }), []);

    return (
      <div className="watch">
        {/* YT.Player mounts INTO this div (it replaces the contents). */}
        <div ref={containerRef} className="watch__player" />

        {!isReady && (
          <div className="watch__loading">
            <span className="loading-line">
              <span className="btn__spinner" aria-hidden="true" />
              Loading the video
            </span>
          </div>
        )}

        <div className="watch__top">
          <span className="chip chip--glass">
            <PlayIcon size={15} />
            {peerDisplayName ? `Watching with ${peerDisplayName}` : 'Watching together'}
          </span>
          {/* Exits watch mode for both of you. */}
          <IconButton label="Stop watching together" size="sm" tip="below" onClick={onClose}>
            <CloseIcon size={17} />
          </IconButton>
        </div>
      </div>
    );
  }
);

/* ────────────────────────────────────────────────────────────── */
/* URL → videoId extractor. YouTube has a zoo of URL shapes:        */
/*   https://www.youtube.com/watch?v=ID                              */
/*   https://youtu.be/ID                                              */
/*   https://www.youtube.com/embed/ID                                 */
/*   https://www.youtube.com/shorts/ID                                */
/* We normalize all of them to the 11-char video ID.                 */
/* ────────────────────────────────────────────────────────────── */

export function extractYouTubeVideoId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Bare 11-char ID (user pasted just the slug)
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    if (host === 'youtu.be') {
      const id = url.pathname.replace(/^\//, '').split('/')[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const v = url.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const m = url.pathname.match(/\/(embed|shorts|v)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[2];
    }
  } catch {
    // Not a valid URL — fall through to null.
  }
  return null;
}

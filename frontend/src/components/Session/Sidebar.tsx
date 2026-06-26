import { logger } from '../../services/logger';
import { useEffect, useRef } from 'react';
import { ChatPanel } from '../Chat/ChatPanel';
import { Doodle } from '../manga';
import { usePictureInPicture } from '../../hooks/usePictureInPicture';

interface SidebarProps {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  remoteDisplayName: string | null;
  peerHasLeft: boolean;
  onSendMessage: (message: string) => void;
  peerVolume?: number;
  /**
   * Peer media flags — sourced from SignalR's PeerMediaStateChanged
   * (already wired through SessionContext). We show them on the peer's
   * CamTile so the user sees *why* there's no audio coming through, or
   * why the peer's tile is a blank panel.
   */
  peerIsMuted?: boolean;
  peerIsCameraOff?: boolean;
  /** Local flags — purely cosmetic mirror so the "you" tile reflects own state. */
  localIsMuted?: boolean;
  localIsCameraOff?: boolean;
  /** Peer currently composing in chat. Surfaces a "…is typing" line in
   *  ChatPanel's header so the local user knows a message is in flight. */
  isPeerTyping?: boolean;
  peerTypingName?: string | null;
  /** Local input fires this on each keystroke; parent throttles before
   *  hitting the wire so we don't spam SignalR. */
  onLocalTyping?: () => void;
}

export function Sidebar({
  localStream,
  remoteStream,
  remoteDisplayName,
  peerHasLeft,
  onSendMessage,
  peerVolume = 100,
  peerIsMuted = false,
  peerIsCameraOff = false,
  localIsMuted = false,
  localIsCameraOff = false,
  isPeerTyping = false,
  peerTypingName = null,
  onLocalTyping,
}: SidebarProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  // Native PiP on the peer's video tile. Auto-on-hide pops the peer
  // out into a floating window the moment the user switches tabs, and
  // exits PiP when they come back — keeps the call visible without
  // requiring the user to know the toggle exists. The toggle button
  // on the tile is still there for manual control on supported browsers.
  const peerPip = usePictureInPicture({ videoRef: remoteVideoRef, autoOnHide: true });

  // Update local video
  useEffect(() => {
    if (localVideoRef.current) {
      if (localStream) {
        localVideoRef.current.srcObject = localStream;
        logger.debug('[Sidebar] Local stream set, tracks:', localStream.getTracks().map((t) => t.kind));
      } else {
        localVideoRef.current.srcObject = null;
      }
    }
  }, [localStream]);

  // Update remote video (muted — audio handled separately)
  useEffect(() => {
    if (remoteVideoRef.current) {
      if (remoteStream) {
        remoteVideoRef.current.srcObject = remoteStream;
        const tracks = remoteStream.getTracks();
        logger.debug('[Sidebar] Remote video stream set, tracks:', tracks.map((t) => ({
          kind: t.kind,
          enabled: t.enabled,
          muted: t.muted,
          readyState: t.readyState,
        })));
        remoteVideoRef.current.play().catch((err) => {
          logger.debug('[Sidebar] Video autoplay blocked:', err.message);
        });
      } else {
        remoteVideoRef.current.srcObject = null;
        remoteVideoRef.current.load();
      }
    }
  }, [remoteStream]);

  // Handle remote audio
  useEffect(() => {
    if (remoteAudioRef.current) {
      if (remoteStream) {
        const audioTracks = remoteStream.getAudioTracks();
        if (audioTracks.length > 0) {
          const audioStream = new MediaStream(audioTracks);
          remoteAudioRef.current.srcObject = audioStream;
          remoteAudioRef.current
            .play()
            .then(() => logger.debug('[Sidebar] Audio playing successfully'))
            .catch((err) => logger.debug('[Sidebar] Audio autoplay blocked:', err.message));
        }
      } else {
        remoteAudioRef.current.srcObject = null;
      }
    }
  }, [remoteStream]);

  useEffect(() => {
    if (remoteAudioRef.current) {
      remoteAudioRef.current.volume = peerVolume / 100;
    }
  }, [peerVolume]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        gap: 10,
        minHeight: 0,
      }}
    >
      <audio ref={remoteAudioRef} autoPlay playsInline />

      {/* Camera tiles — stacked vertically on desktop, side-by-side on mobile via wrap */}
      <div className="cam-tiles" style={{ display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0 }}>
        <CamTile
          videoRef={remoteVideoRef}
          stream={remoteStream}
          name={remoteDisplayName ?? 'peer'}
          tilt={-2}
          accent="pink"
          isMuted={peerIsMuted}
          isCameraOff={peerIsCameraOff}
          pip={peerPip.isSupported ? { isActive: peerPip.isActive, onToggle: peerPip.toggle } : undefined}
          empty={
            peerHasLeft ? (
              <PeerEmpty label="peer left" />
            ) : (
              <PeerEmpty label={remoteDisplayName ? 'connecting…' : 'waiting'} />
            )
          }
        />
        <CamTile
          videoRef={localVideoRef}
          stream={localStream}
          name="you"
          tilt={2}
          accent="purple"
          mirror
          isMuted={localIsMuted}
          isCameraOff={localIsCameraOff}
          empty={<PeerEmpty label="camera off" />}
        />
      </div>

      {/* Chat — hidden on mobile, takes remaining space on desktop */}
      <div className="sidebar-chat" style={{ flex: 1, minHeight: 0 }}>
        <ChatPanel
          onSendMessage={onSendMessage}
          onTyping={onLocalTyping}
          isPeerTyping={isPeerTyping}
          peerTypingName={peerTypingName}
          peerName={remoteDisplayName}
        />
      </div>
    </div>
  );
}

interface CamTileProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  stream: MediaStream | null;
  name: string;
  tilt: number;
  accent: 'pink' | 'purple';
  mirror?: boolean;
  empty: React.ReactNode;
  /** Show mic-slash badge — peer is muted. */
  isMuted?: boolean;
  /** Render camera-off curtain on top of the video element. */
  isCameraOff?: boolean;
  /**
   * Optional PiP toggle for this tile. Pass undefined (default) to hide
   * the button — typically only the peer tile gets one, since popping
   * out your own face is rarely useful.
   */
  pip?: { isActive: boolean; onToggle: () => Promise<void> | void };
}

function CamTile({ videoRef, stream, name, tilt, accent, mirror, empty, isMuted, isCameraOff, pip }: CamTileProps) {
  const accentVar = accent === 'pink' ? 'var(--pink)' : 'var(--purple)';
  return (
    <div
      style={{
        position: 'relative',
        border: '3.5px solid var(--ink)',
        borderRadius: 4,
        background: 'var(--cream)',
        boxShadow: `5px 5px 0 ${accentVar}`,
        aspectRatio: '4 / 3',
        overflow: 'hidden',
        transform: `rotate(${tilt}deg)`,
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          background: 'var(--cream-deep)',
          transform: mirror ? 'scaleX(-1)' : undefined,
          // Camera-off curtain is opaque; we keep the <video> mounted so the
          // moment the peer flips their camera back on the track lights up
          // without needing to re-attach srcObject.
          opacity: isCameraOff ? 0 : 1,
          transition: 'opacity 150ms ease',
        }}
      />

      {/* Camera-off overlay — same chibi-style empty state, but drawn over a
          live track so we can drop it instantly without re-mounting. */}
      {stream && isCameraOff && (
        <div
          aria-label="camera off"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            background: 'var(--cream-deep)',
          }}
        >
          <PeerEmpty label="camera off" />
        </div>
      )}

      {!stream && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            background: 'var(--cream-deep)',
          }}
        >
          {empty}
        </div>
      )}

      {/* Mic-slash badge — top-right corner, sticker-style. Renders regardless
          of camera state because muting is independent of the video track. */}
      {isMuted && (
        <div
          aria-label={`${name} is muted`}
          title={`${name} is muted`}
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            background: 'var(--orange)',
            border: '2.5px solid var(--ink)',
            boxShadow: '2px 2px 0 var(--ink)',
            padding: '2px 6px',
            fontFamily: 'var(--font-sfx)',
            fontSize: 14,
            letterSpacing: 1,
            color: 'var(--ink)',
            transform: 'rotate(4deg)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span aria-hidden="true">🔇</span>
          <span>MUTED</span>
        </div>
      )}

      {/* Name plate */}
      <div
        style={{
          position: 'absolute',
          left: 6,
          bottom: 6,
          background: 'var(--cream)',
          border: '2.5px solid var(--ink)',
          padding: '2px 8px',
          fontFamily: 'var(--font-sfx)',
          fontSize: 12,
          letterSpacing: 1,
          transform: 'rotate(-2deg)',
        }}
      >
        {name}
      </div>

      {/* PiP toggle — top-left corner. Manga sticker-style: small purple
          square with the pop-out doodle. Only renders when the parent
          passes a `pip` prop (typically only for the peer tile). */}
      {pip && stream && (
        <button
          type="button"
          onClick={() => { void pip.onToggle(); }}
          aria-label={pip.isActive ? 'exit picture-in-picture' : 'pop out to floating window'}
          aria-pressed={pip.isActive}
          title={pip.isActive ? 'exit pop-out' : 'pop out'}
          style={{
            position: 'absolute',
            top: 6,
            left: 6,
            width: 26,
            height: 26,
            background: pip.isActive ? 'var(--purple)' : 'var(--cream)',
            color: pip.isActive ? 'var(--cream)' : 'var(--ink)',
            border: '2.5px solid var(--ink)',
            boxShadow: '2px 2px 0 var(--ink)',
            padding: 0,
            cursor: 'pointer',
            transform: 'rotate(-4deg)',
            display: 'grid',
            placeItems: 'center',
            transition: 'background 150ms ease, transform 150ms ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'rotate(0) scale(1.1)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'rotate(-4deg) scale(1)';
          }}
        >
          {/* Pop-out icon — rect with arrow up-right */}
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M9 2h5v5M14 2L8 8M3 4h4M3 4v8h8v-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

function PeerEmpty({ label }: { label: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <Doodle kind="z" size={32} color="rgba(26,20,23,0.4)" />
      <div className="hand" style={{ fontSize: 16, color: 'rgba(26,20,23,0.55)', marginTop: 4 }}>
        {label}
      </div>
    </div>
  );
}

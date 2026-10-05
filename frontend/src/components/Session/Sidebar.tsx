import { logger } from '../../services/logger';
import { useEffect, useRef } from 'react';
import { ChatPanel } from '../Chat/ChatPanel';
import { IconButton } from '../ui/Button';
import { CloseIcon, MicOffIcon, PopOutIcon } from '../ui/icons';
import { usePictureInPicture } from '../../hooks/usePictureInPicture';

interface SidebarProps {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  remoteDisplayName: string | null;
  localDisplayName?: string;
  peerHasLeft: boolean;
  onSendMessage: (message: string) => void;
  peerVolume?: number;
  /**
   * Peer media flags — from the room's PeerMediaStateChanged. We show them on
   * the peer's tile so the user sees *why* there's no audio coming through,
   * or why the peer's tile is dark.
   */
  peerIsMuted?: boolean;
  peerIsCameraOff?: boolean;
  /** Local flags — purely cosmetic mirror so the "you" tile reflects own state. */
  localIsMuted?: boolean;
  localIsCameraOff?: boolean;
  /** Peer currently composing in chat. */
  isPeerTyping?: boolean;
  peerTypingName?: string | null;
  /** Local input fires this on each keystroke; parent throttles before
   *  hitting the wire. */
  onLocalTyping?: () => void;
  /**
   * Fold the faces away. The stage already shows the other person large when
   * nobody is sharing, and two more copies of the same faces just take room
   * from the chat. Folded, not unmounted: the peer's <video> is also the
   * picture-in-picture source, and it has to keep decoding.
   */
  foldTiles?: boolean;
  /** Close the panel — present on layouts where it floats over the stage. */
  onClose?: () => void;
}

export function Sidebar({
  localStream,
  remoteStream,
  remoteDisplayName,
  localDisplayName,
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
  foldTiles = false,
  onClose,
}: SidebarProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const peerTileRef = useRef<HTMLDivElement>(null);
  const localTileRef = useRef<HTMLDivElement>(null);


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

  const peerLabel = remoteDisplayName ?? 'Them';

  return (
    <div className="side">
      <audio ref={remoteAudioRef} autoPlay playsInline />

      <div className="side__grab" aria-hidden="true" />
      <div className="side__head">
        <span className="muted" style={{ fontWeight: 700, fontSize: '0.9rem' }}>
          {remoteDisplayName ? `You and ${remoteDisplayName}` : 'Just you so far'}
        </span>
        {onClose && (
          <IconButton label="Close panel" size="sm" bare tip={false} onClick={onClose}>
            <CloseIcon size={18} />
          </IconButton>
        )}
      </div>

      <div className="tiles-fold" data-folded={foldTiles ? '' : undefined}>
        <div className="tiles">
          <CamTile
            tileRef={peerTileRef}
            videoRef={remoteVideoRef}
            stream={remoteStream}
            name={peerLabel}
            who="them"
            isMuted={peerIsMuted}
            isCameraOff={peerIsCameraOff}
            pip={peerPip.isSupported ? { isActive: peerPip.isActive, onToggle: peerPip.toggle } : undefined}
            emptyLabel={peerHasLeft ? 'They left' : remoteDisplayName ? 'Connecting…' : 'Empty seat'}
          />
          <CamTile
            tileRef={localTileRef}
            videoRef={localVideoRef}
            stream={localStream}
            name={localDisplayName ? `${localDisplayName} (you)` : 'You'}
            who="you"
            mirror
            isMuted={localIsMuted}
            isCameraOff={localIsCameraOff}
            emptyLabel="Camera off"
          />
        </div>
      </div>

      <ChatPanel
        onSendMessage={onSendMessage}
        onTyping={onLocalTyping}
        isPeerTyping={isPeerTyping}
        peerTypingName={peerTypingName}
        peerName={remoteDisplayName}
      />
    </div>
  );
}

interface CamTileProps {
  tileRef: React.RefObject<HTMLDivElement | null>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  stream: MediaStream | null;
  name: string;
  who: 'you' | 'them';
  mirror?: boolean;
  emptyLabel: string;
  /** Show the muted badge. */
  isMuted?: boolean;
  /** Cover the video — kept mounted so it lights up instantly when back on. */
  isCameraOff?: boolean;
  /**
   * Optional PiP toggle for this tile. Pass undefined (default) to hide
   * the button — typically only the peer tile gets one, since popping
   * out your own face is rarely useful.
   */
  pip?: { isActive: boolean; onToggle: () => Promise<void> | void };
}

function CamTile({ tileRef, videoRef, stream, name, who, mirror, emptyLabel, isMuted, isCameraOff, pip }: CamTileProps) {
  const initial = name.charAt(0).toUpperCase();
  return (
    <div className="tile" data-who={who} ref={tileRef}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          transform: mirror ? 'scaleX(-1)' : undefined,
          // Camera-off curtain is opaque; we keep the <video> mounted so the
          // moment the peer flips their camera back on the track lights up
          // without needing to re-attach srcObject.
          opacity: isCameraOff || !stream ? 0 : 1,
        }}
      />

      {(!stream || isCameraOff) && (
        <div className="tile__empty" aria-label={isCameraOff ? `${name}: camera off` : undefined}>
          <span
            className="avatar"
            data-who={who === 'them' ? 'them' : undefined}
            style={{ ['--av' as string]: '40px' }}
            aria-hidden="true"
          >
            {initial}
          </span>
          <span>{isCameraOff && stream ? 'Camera off' : emptyLabel}</span>
        </div>
      )}

      {isMuted && (
        <span className="tile__muted" aria-label={`${name} is muted`} title={`${name} is muted`}>
          <MicOffIcon size={14} />
        </span>
      )}

      <span className="chip chip--glass tile__name">{name}</span>

      {pip && stream && (
        <IconButton
          className="tile__pip"
          size="sm"
          tip="below"
          label={pip.isActive ? 'Exit picture-in-picture' : 'Pop out to a floating window'}
          aria-pressed={pip.isActive}
          onClick={() => {
            void pip.onToggle();
          }}
        >
          <PopOutIcon size={15} />
        </IconButton>
      )}
    </div>
  );
}

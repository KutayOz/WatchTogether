import { useState, type ReactNode } from 'react';
import { type ScreenShareQuality, type SpeedTestResult, QUALITY_PRESETS } from '../../types';

interface MediaControlsProps {
  isMuted: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onLeave: () => void;
  canShare?: boolean;
  screenShareQuality?: ScreenShareQuality;
  onQualityChange?: (quality: ScreenShareQuality) => void;
  isSharer?: boolean;
  isFullscreen?: boolean;
  showPeerCamera?: boolean;
  onTogglePeerCamera?: () => void;
  hasPeerCamera?: boolean;
  hasPeer?: boolean;
  peerDisplayName?: string;
  peerVolume?: number;
  onPeerVolumeChange?: (volume: number) => void;
  hasScreenAudio?: boolean;
  screenAudioVolume?: number;
  onScreenAudioVolumeChange?: (volume: number) => void;
  speedTestResult?: SpeedTestResult | null;
}

export function MediaControls({
  isMuted,
  isCameraOn,
  isScreenSharing,
  onToggleMute,
  onToggleCamera,
  onToggleScreenShare,
  onLeave,
  canShare = true,
  screenShareQuality = 'high',
  onQualityChange,
  isSharer = false,
  isFullscreen = false,
  showPeerCamera = true,
  onTogglePeerCamera,
  hasPeerCamera = false,
  hasPeer = false,
  peerDisplayName,
  peerVolume = 100,
  onPeerVolumeChange,
  hasScreenAudio = false,
  screenAudioVolume = 100,
  onScreenAudioVolumeChange,
  speedTestResult,
}: MediaControlsProps) {
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [showVoiceMenu, setShowVoiceMenu] = useState(false);

  const hasVoiceControls = hasPeer || (hasScreenAudio && !isSharer);

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 12,
        padding: '14px 22px',
        background: 'var(--cream)',
        border: '3.5px solid var(--ink)',
        borderRadius: 100,
        boxShadow: '6px 6px 0 var(--ink)',
        transform: 'rotate(-0.6deg)',
        width: 'fit-content',
        margin: '0 auto',
        maxWidth: '100%',
        flexWrap: 'wrap',
      }}
    >
      {/* Microphone */}
      <ControlBtn
        active={isMuted}
        activeColor="orange"
        onClick={onToggleMute}
        title={isMuted ? 'unmute' : 'mute'}
      >
        {isMuted ? <MicOffIcon /> : <MicIcon />}
      </ControlBtn>

      {/* Camera */}
      <ControlBtn
        active={!isCameraOn}
        activeColor="orange"
        onClick={onToggleCamera}
        title={isCameraOn ? 'camera off' : 'camera on'}
      >
        {isCameraOn ? <VideoIcon /> : <VideoOffIcon />}
      </ControlBtn>

      {/* Voice settings popover */}
      <div style={{ position: 'relative' }}>
        <ControlBtn
          active={showVoiceMenu}
          activeColor="purple"
          onClick={() => setShowVoiceMenu((v) => !v)}
          title="voice settings"
          disabled={!hasVoiceControls}
        >
          <VoiceIcon />
        </ControlBtn>
        {showVoiceMenu && hasVoiceControls && (
          <PopMenu onClose={() => setShowVoiceMenu(false)} title="VOICE">
            {!isSharer && hasScreenAudio && onScreenAudioVolumeChange && (
              <VolumeSlider
                label="stream audio"
                value={screenAudioVolume}
                onChange={onScreenAudioVolumeChange}
              />
            )}
            {hasPeer && onPeerVolumeChange && (
              <VolumeSlider
                label={`${peerDisplayName ?? 'peer'}'s voice`}
                value={peerVolume}
                onChange={onPeerVolumeChange}
              />
            )}
            {!hasVoiceControls && (
              <div className="hand" style={{ fontSize: 16, color: 'rgba(26,20,23,0.5)' }}>
                no audio to control
              </div>
            )}
          </PopMenu>
        )}
      </div>

      {/* Screen share — hidden on tiny screens via media check below */}
      <div className="screen-share-group" style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6 }}>
        <ControlBtn
          active={isScreenSharing}
          activeColor="purple"
          onClick={onToggleScreenShare}
          title={isScreenSharing ? 'stop sharing' : canShare ? 'share screen' : 'someone is sharing'}
          disabled={!canShare}
        >
          <ScreenIcon />
        </ControlBtn>

        {(isSharer || !isScreenSharing) ? (
          <>
            <ControlBtn
              active={showQualityMenu}
              activeColor="purple"
              onClick={() => setShowQualityMenu((v) => !v)}
              title={isScreenSharing ? 'change quality' : 'select quality'}
              size="sm"
            >
              <QualityIcon />
            </ControlBtn>

            {showQualityMenu && onQualityChange && (
              <PopMenu onClose={() => setShowQualityMenu(false)} title={isScreenSharing ? 'CHANGE QUALITY' : 'STREAM QUALITY'}>
                {speedTestResult && (
                  <div
                    className="hand"
                    style={{
                      fontSize: 16,
                      color: 'rgba(26,20,23,0.6)',
                      marginBottom: 8,
                      paddingBottom: 8,
                      borderBottom: '2px dashed rgba(26,20,23,0.3)',
                    }}
                  >
                    ↑ upload: {speedTestResult.uploadSpeedMbps} Mbps
                  </div>
                )}
                {isScreenSharing && (
                  <div className="hand" style={{ fontSize: 15, color: 'rgba(26,20,23,0.55)', marginBottom: 6 }}>
                    adjusts live — no interruption
                  </div>
                )}
                {(Object.keys(QUALITY_PRESETS) as ScreenShareQuality[]).map((key) => {
                  const preset = QUALITY_PRESETS[key];
                  const isSelected = screenShareQuality === key;
                  const isRecommended = speedTestResult?.recommendedQuality === key;
                  const isSupported = !speedTestResult || speedTestResult.supportedQualities[key] !== false;
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={!isSupported}
                      onClick={() => {
                        if (!isSupported) return;
                        onQualityChange(key);
                        setShowQualityMenu(false);
                      }}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 10px',
                        marginBottom: 2,
                        background: isSelected ? 'var(--pink)' : 'transparent',
                        color: 'var(--ink)',
                        border: isSelected ? '2.5px solid var(--ink)' : '2.5px solid transparent',
                        borderRadius: 8,
                        cursor: isSupported ? 'pointer' : 'not-allowed',
                        opacity: isSupported ? 1 : 0.45,
                        fontFamily: 'var(--font-body)',
                        fontWeight: 600,
                        transition: 'background .15s, border .15s',
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected && isSupported) e.currentTarget.style.background = 'rgba(255,79,163,0.15)';
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {isRecommended && (
                          <span style={{ color: 'var(--purple)', fontFamily: 'var(--font-sfx)' }}>★</span>
                        )}
                        <span style={{ fontFamily: 'var(--font-sfx)', fontSize: 16, letterSpacing: 1 }}>{preset.label}</span>
                        {isRecommended && (
                          <span className="hand" style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--purple)' }}>
                            recommended
                          </span>
                        )}
                        {!isSupported && (
                          <span className="hand" style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--orange-deep)' }}>
                            may lag
                          </span>
                        )}
                      </div>
                      <div className="hand" style={{ fontSize: 14, color: 'rgba(26,20,23,0.55)', marginTop: 2 }}>
                        {preset.description}
                      </div>
                    </button>
                  );
                })}
              </PopMenu>
            )}
          </>
        ) : (
          <div
            className="hand"
            style={{
              padding: '6px 12px',
              border: '2.5px solid var(--ink)',
              borderRadius: 999,
              background: 'var(--cream)',
              fontSize: 14,
              color: 'var(--ink)',
            }}
          >
            {QUALITY_PRESETS[screenShareQuality]?.label ?? screenShareQuality}
          </div>
        )}
      </div>

      {/* Peer camera toggle — fullscreen only */}
      {isFullscreen && hasPeerCamera && onTogglePeerCamera && (
        <ControlBtn
          active={!showPeerCamera}
          activeColor="orange"
          onClick={onTogglePeerCamera}
          title={showPeerCamera ? 'hide peer cam' : 'show peer cam'}
        >
          <PeerCameraIcon show={showPeerCamera} />
        </ControlBtn>
      )}

      {/* Dashed divider */}
      <span
        aria-hidden="true"
        style={{ width: 0, borderLeft: '2px dashed var(--ink)', height: 32, marginLeft: 4 }}
      />

      {/* Leave — bright orange, bigger */}
      <LeaveBtn onClick={onLeave} />
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */
/* ControlBtn — circular sticker button used in the controls bar */
/* ──────────────────────────────────────────────────────────── */

interface ControlBtnProps {
  children: ReactNode;
  active?: boolean;
  activeColor?: 'pink' | 'orange' | 'purple';
  onClick?: () => void;
  title?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
}

function ControlBtn({
  children,
  active = false,
  activeColor = 'pink',
  onClick,
  title,
  size = 'md',
  disabled = false,
}: ControlBtnProps) {
  const dim = size === 'sm' ? 40 : 50;
  const activeBg = `var(--${activeColor})`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      // aria-label mirrors the `title` so screen readers get the same
      // affordance the tooltip shows mouse users. aria-pressed makes the
      // toggle nature of mute/camera-off legible to assistive tech —
      // without it, "mute" reads as a one-shot action instead of state.
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      style={{
        width: dim,
        height: dim,
        border: '3px solid var(--ink)',
        borderRadius: '50%',
        background: active ? activeBg : 'var(--cream)',
        color: active && activeColor === 'purple' ? 'var(--cream)' : 'var(--ink)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'grid',
        placeItems: 'center',
        transform: `rotate(${active ? 0 : -2}deg)`,
        transition: 'transform .15s, background .15s, box-shadow .15s',
        boxShadow: '3px 3px 0 var(--ink)',
        padding: 0,
        opacity: disabled ? 0.4 : 1,
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.transform = 'rotate(0) translateY(-3px) scale(1.08)';
        e.currentTarget.style.boxShadow = '5px 5px 0 var(--ink)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = `rotate(${active ? 0 : -2}deg)`;
        e.currentTarget.style.boxShadow = '3px 3px 0 var(--ink)';
      }}
    >
      {children}
    </button>
  );
}

/* ──────────────────────────────────────────────────────────── */
/* LeaveBtn — orange exit                                       */
/* ──────────────────────────────────────────────────────────── */

function LeaveBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Leave session"
      title="leave session"
      style={{
        background: 'var(--orange)',
        border: '3px solid var(--ink)',
        borderRadius: 12,
        padding: '10px 18px 8px',
        fontFamily: 'var(--font-sfx)',
        fontSize: 20,
        letterSpacing: 1,
        cursor: 'pointer',
        color: 'var(--ink)',
        boxShadow: '4px 4px 0 var(--ink)',
        transform: 'rotate(1.5deg)',
        transition: 'transform .15s, box-shadow .15s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'rotate(0) translate(-2px, -2px) scale(1.05)';
        e.currentTarget.style.boxShadow = '6px 6px 0 var(--ink)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'rotate(1.5deg)';
        e.currentTarget.style.boxShadow = '4px 4px 0 var(--ink)';
      }}
    >
      LEAVE
    </button>
  );
}

/* ──────────────────────────────────────────────────────────── */
/* PopMenu — sticker-style dropdown                             */
/* ──────────────────────────────────────────────────────────── */

interface PopMenuProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
}

function PopMenu({ title, children, onClose }: PopMenuProps) {
  return (
    <div
      onMouseLeave={onClose}
      style={{
        position: 'absolute',
        bottom: 'calc(100% + 12px)',
        left: '50%',
        transform: 'translateX(-50%) rotate(-1deg)',
        minWidth: 240,
        background: 'var(--cream)',
        border: '3.5px solid var(--ink)',
        borderRadius: 12,
        boxShadow: '6px 6px 0 var(--ink)',
        padding: 14,
        zIndex: 5000,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-sfx)',
          fontSize: 14,
          letterSpacing: 1.5,
          color: 'var(--purple)',
          marginBottom: 10,
          paddingBottom: 6,
          borderBottom: '2px dashed rgba(26,20,23,0.25)',
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function VolumeSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span className="hand" style={{ fontSize: 16, color: 'var(--ink)' }}>{label}</span>
        <span style={{ fontFamily: 'var(--font-sfx)', fontSize: 14, color: 'var(--pink)' }}>{value}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          width: '100%',
          accentColor: 'var(--pink)',
          cursor: 'pointer',
        }}
      />
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */
/* Icons                                                        */
/* ──────────────────────────────────────────────────────────── */

const iconCommon = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function MicIcon() {
  return (
    <svg {...iconCommon}>
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 12 Q 5 19 12 19 Q 19 19 19 12" />
      <line x1="12" y1="19" x2="12" y2="23" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg {...iconCommon}>
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 12 Q 5 19 12 19 Q 19 19 19 12" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="3" y1="3" x2="21" y2="21" stroke="var(--purple)" strokeWidth="3" />
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg {...iconCommon}>
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="M16 10 L 22 7 L 22 17 L 16 14 Z" />
    </svg>
  );
}

function VideoOffIcon() {
  return (
    <svg {...iconCommon}>
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="M16 10 L 22 7 L 22 17 L 16 14 Z" />
      <line x1="3" y1="3" x2="21" y2="21" stroke="var(--purple)" strokeWidth="3" />
    </svg>
  );
}

function VoiceIcon() {
  return (
    <svg {...iconCommon}>
      <path d="M5 9 L 5 15 L 9 15 L 14 19 L 14 5 L 9 9 Z" />
      <path d="M17 8 Q 20 12 17 16" />
    </svg>
  );
}

function ScreenIcon() {
  return (
    <svg {...iconCommon}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <path d="M12 6 L 12 14 M 8 10 L 12 6 L 16 10" />
    </svg>
  );
}

function QualityIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="12" y1="21" x2="12" y2="10" />
      <line x1="20" y1="21" x2="20" y2="6" />
    </svg>
  );
}

function PeerCameraIcon({ show }: { show: boolean }) {
  return (
    <svg {...iconCommon}>
      <circle cx="12" cy="9" r="4" />
      <path d="M4 21 Q 4 14 12 14 Q 20 14 20 21" />
      {!show && <line x1="3" y1="3" x2="21" y2="21" stroke="var(--purple)" strokeWidth="3" />}
    </svg>
  );
}

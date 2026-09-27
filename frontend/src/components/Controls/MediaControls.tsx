import { useRef, useState, type ReactNode } from 'react';
import { m } from 'motion/react';
import {
  type ScreenShareQuality,
  type UplinkEstimate,
  type ContentMode,
  type ShareStatus,
  QUALITY_PRESETS,
  CONTENT_MODES,
} from '../../types';
import {
  formatTransportPath,
  type TransportDiagnostics,
} from '../../hooks/useTransportDiagnostics';
import type { OperatingPoint } from '../../hooks/operatingPoint';
import { jitterBufferMs, type InboundScreenStats } from '../../hooks/useQualityMonitor';
import { SOURCE_IDLE_FPS_RATIO } from '../../hooks/useSenderHealth';
import { canCaptureScreen } from '../../utils/capabilities';
import { Button, IconButton } from '../ui/Button';
import { Popover } from '../ui/Popover';
import { useDismiss } from '../ui/useDismiss';
import {
  CamIcon,
  CamOffIcon,
  ChatIcon,
  ClipboardIcon,
  LeaveIcon,
  MicIcon,
  MicOffIcon,
  MoreIcon,
  PersonIcon,
  QualityIcon,
  ScreenIcon,
  ScreenStopIcon,
  SmileIcon,
  VolumeIcon,
} from '../ui/icons';

/** An extra entry for the "more" menu — watch together, blur, shortcuts. */
export interface DockMenuItem {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  onSelect: () => void;
  /** For toggles: rendered as aria-pressed with an on/off state. */
  pressed?: boolean;
  disabled?: boolean;
}

export interface MediaControlsProps {
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
  /** Null means the browser gives no bitrate estimate — show no advice at all. */
  uplink?: UplinkEstimate | null;
  /** Live transport path + encoder readout. Null entries render nothing. */
  diagnostics?: TransportDiagnostics | null;
  /**
   * What the encoder was ASKED for, so the overlay can show it beside what the
   * encoder achieved. Without the pair, `sending: 344x182 @ 1` reads as a
   * deliberate choice rather than the encoder giving up on our ask.
   */
  appliedPoint?: OperatingPoint | null;
  /** True when the budget is pinned at its floor — the link cannot fund more. */
  atBudgetFloor?: boolean;
  /**
   * What THIS end is receiving, when watching someone else's share.
   *
   * The sender's own readout ("sending", "asked", "limited by") is above; this
   * is the other half, and it is the half that was missing. Freezing is a thing
   * only the receiver can see.
   */
  inbound?: InboundScreenStats | null;
  /** What the sharer says their encoder is doing, or null if they have not said. */
  peerShare?: ShareStatus | null;
  contentMode?: ContentMode;
  onContentModeChange?: (mode: ContentMode) => void;
  /**
   * Build and show the debug report.
   *
   * Offered from the "more" menu rather than the quality panel on purpose:
   * the person who most needs it is the one watching someone else's share,
   * which is exactly the person with least reason to open quality settings.
   */
  onDebugReport?: () => void;
  /** Extra "more" menu entries supplied by the room. */
  menuItems?: DockMenuItem[];
  /** Send a reaction. Omitted when there is nobody to react to. */
  onReact?: (emoji: string) => void;
  /** The chat / side panel toggle, with its unread count. */
  chat?: { open: boolean; unread: number; onToggle: () => void };
}

/**
 * The quality and voice half of the props.
 *
 * MediaControls is rendered twice — in the windowed layout, and inside
 * ScreenShareView's container so the fullscreen top layer has a control bar —
 * and the fullscreen copy shipped without any of these for its whole life. The
 * quality button still rendered there (it is gated on
 * `isSharer || !isScreenSharing`) but its menu is gated on `onQualityChange`,
 * so it was a dead button; and the VOICE menu opened empty, because the peer
 * slider needs `onPeerVolumeChange`. One named type, so both call sites are
 * fed from the same object and cannot drift apart again.
 */
export type MediaControlsQualityProps = Pick<
  MediaControlsProps,
  | 'screenShareQuality'
  | 'onQualityChange'
  | 'uplink'
  | 'diagnostics'
  | 'appliedPoint'
  | 'atBudgetFloor'
  | 'inbound'
  | 'peerShare'
  | 'contentMode'
  | 'onContentModeChange'
  | 'peerVolume'
  | 'onPeerVolumeChange'
>;

type Panel = 'quality' | 'voice' | 'more' | 'react';

const REACTION_EMOJI = ['🩷', '😂', '🔥', '👏', '👍', '🤯'];

/**
 * The dock: every control for the call in one floating bar.
 *
 * The primary controls (mic, camera, share, leave) are always in the bar.
 * Quality and volume get their own buttons where there is room and move into
 * the "more" menu on a narrow screen, so a phone keeps a bar that fits a thumb
 * instead of one that scrolls. Every panel opens from the same spot above the
 * bar and closes on Escape or a tap outside — never on the pointer merely
 * drifting off it, which on a touch screen could never be done on purpose.
 */
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
  uplink,
  diagnostics,
  appliedPoint,
  atBudgetFloor = false,
  inbound,
  peerShare,
  onDebugReport,
  contentMode = 'film',
  onContentModeChange,
  menuItems = [],
  onReact,
  chat,
}: MediaControlsProps) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  useDismiss(dockRef, () => setPanel(null), panel !== null);

  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));
  const hasVoiceControls = hasPeer || (hasScreenAudio && !isSharer);
  // Kept exactly as it was: whoever is sharing, or anyone while nobody is.
  const showQuality = isSharer || !isScreenSharing;
  // Screen capture does not exist on phones; a button that can only throw
  // is worse than no button.
  const canCapture = canCaptureScreen();

  const moreItems: DockMenuItem[] = [
    ...menuItems,
    ...(onDebugReport
      ? [
          {
            id: 'debug',
            label: 'Debug report',
            hint: 'Copy what the call is doing, for a bug report',
            icon: <ClipboardIcon size={18} />,
            onSelect: onDebugReport,
          },
        ]
      : []),
  ];

  return (
    <div className="dock" ref={dockRef} role="toolbar" aria-label="Call controls">
      <div className="dock__group">
        <IconButton
          className="dock-btn"
          label={isMuted ? 'Unmute' : 'Mute'}
          data-state={isMuted ? 'off' : undefined}
          onClick={onToggleMute}
        >
          <SwapIcon on={!isMuted} onIcon={<MicIcon size={21} />} offIcon={<MicOffIcon size={21} />} />
        </IconButton>
        <IconButton
          className="dock-btn"
          label={isCameraOn ? 'Turn camera off' : 'Turn camera on'}
          data-state={isCameraOn ? undefined : 'off'}
          onClick={onToggleCamera}
        >
          <SwapIcon on={isCameraOn} onIcon={<CamIcon size={21} />} offIcon={<CamOffIcon size={21} />} />
        </IconButton>
        {(canCapture || isScreenSharing) && (
          <IconButton
            className="dock-btn"
            label={isScreenSharing ? 'Stop sharing' : canShare ? 'Share screen' : 'Someone is sharing'}
            data-state={isScreenSharing ? 'on' : undefined}
            onClick={onToggleScreenShare}
            disabled={!canShare}
          >
            {isScreenSharing ? <ScreenStopIcon size={21} /> : <ScreenIcon size={21} />}
          </IconButton>
        )}
      </div>

      <div className="dock__group">
        <span className="dock__secondary">
          {showQuality && (
            <IconButton
              className="dock-btn"
              label={isScreenSharing ? 'Change quality' : 'Stream quality'}
              aria-expanded={panel === 'quality'}
              aria-haspopup="dialog"
              onClick={() => toggle('quality')}
            >
              <QualityIcon size={20} />
            </IconButton>
          )}
          <IconButton
            className="dock-btn"
            label="Volume"
            aria-expanded={panel === 'voice'}
            aria-haspopup="dialog"
            onClick={() => toggle('voice')}
            disabled={!hasVoiceControls}
          >
            <VolumeIcon size={20} />
          </IconButton>
        </span>

        {isFullscreen && hasPeerCamera && onTogglePeerCamera && (
          <IconButton
            className="dock-btn"
            label={showPeerCamera ? 'Hide their camera' : 'Show their camera'}
            aria-pressed={!showPeerCamera}
            onClick={onTogglePeerCamera}
          >
            <PersonIcon size={20} />
          </IconButton>
        )}

        {onReact && (
          <IconButton
            className="dock-btn"
            label="React"
            aria-expanded={panel === 'react'}
            aria-haspopup="dialog"
            onClick={() => toggle('react')}
          >
            <SmileIcon size={21} />
          </IconButton>
        )}

        {chat && (
          <IconButton
            className="dock-btn"
            label={chat.open ? 'Hide chat' : 'Show chat'}
            onClick={chat.onToggle}
          >
            <ChatIcon size={20} />
            {!chat.open && chat.unread > 0 && (
              <span className="dock-btn__badge" aria-label={`${chat.unread} unread message${chat.unread === 1 ? '' : 's'}`}>
                {chat.unread > 9 ? '9+' : chat.unread}
              </span>
            )}
          </IconButton>
        )}

        <IconButton
          className="dock-btn"
          label="More"
          aria-expanded={panel === 'more'}
          aria-haspopup="dialog"
          onClick={() => toggle('more')}
        >
          <MoreIcon size={20} />
        </IconButton>
      </div>

      <span className="dock__divider" aria-hidden="true" />

      <Button variant="danger" className="dock-leave" icon={<LeaveIcon size={20} />} onClick={onLeave} aria-label="Leave session">
        <span className="dock-leave__label">Leave</span>
      </Button>

      {/* ── panels ─────────────────────────────────────────────────────── */}

      <Popover open={panel === 'react'} label="Reactions" className="dock-panel dock-react-panel">
        <div className="react-tray">
          {REACTION_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="react-tray__btn"
              aria-label={`React with ${emoji}`}
              onClick={() => onReact?.(emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
      </Popover>

      <Popover open={panel === 'voice'} title="Volume" className="dock-panel">
        {!isSharer && hasScreenAudio && onScreenAudioVolumeChange && (
          <VolumeSlider label="Shared audio" value={screenAudioVolume} onChange={onScreenAudioVolumeChange} />
        )}
        {hasPeer && onPeerVolumeChange && (
          <VolumeSlider label={`${peerDisplayName ?? 'Their'} voice`} value={peerVolume} onChange={onPeerVolumeChange} />
        )}
        {!hasVoiceControls && <p className="muted">No audio to control yet.</p>}
      </Popover>

      <Popover open={panel === 'quality' && !!onQualityChange} title={isScreenSharing ? 'Change quality' : 'Stream quality'} className="dock-panel">
        <Diagnostics
          uplink={uplink}
          diagnostics={diagnostics}
          appliedPoint={appliedPoint}
          atBudgetFloor={atBudgetFloor}
          inbound={inbound}
          peerShare={peerShare}
        />
        {isScreenSharing && <p className="panel-label">Changes apply live, without interrupting the share.</p>}

        {/* Content mode. Frame rate is the cheapest sharpness lever there is:
            film is 24 fps at source, so encoding it at 30 divides the budget
            over 25% more frames for nothing. */}
        {onContentModeChange && (
          <>
            <p className="panel-label">What are you sharing?</p>
            <div className="modes">
              {(Object.keys(CONTENT_MODES) as ContentMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className="mode"
                  title={CONTENT_MODES[mode].description}
                  aria-pressed={contentMode === mode}
                  onClick={() => onContentModeChange(mode)}
                >
                  {CONTENT_MODES[mode].label}
                  <small>{CONTENT_MODES[mode].fps} fps</small>
                </button>
              ))}
            </div>
          </>
        )}

        <p className="panel-label">Quality ceiling</p>
        <div className="presets" role="radiogroup" aria-label="Quality ceiling">
          {(Object.keys(QUALITY_PRESETS) as ScreenShareQuality[]).map((key) => {
            const preset = QUALITY_PRESETS[key];
            const isSelected = screenShareQuality === key;
            const isRecommended = uplink?.recommendedQuality === key;
            // Advisory only. Never `disabled`: a preset is a ceiling, and a
            // ceiling above your link costs nothing — chooseOperatingPoint
            // still sits on the budget. Locking these was what left a
            // collapsed session with no way out, and on a fast link it is
            // what kept everything above `auto` permanently out of reach,
            // since `auto` bounds the very estimate the lock consults.
            const aboveLink = !!uplink && uplink.withinEstimate[key] === false;
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={isSelected}
                className="preset"
                onClick={() => {
                  onQualityChange?.(key);
                  setPanel(null);
                }}
              >
                <span className="preset__radio" aria-hidden="true" />
                <span className="preset__name">
                  {preset.label}
                  <small>{preset.description}</small>
                </span>
                {isRecommended ? (
                  <span className="preset__tag" data-kind="recommended">
                    Recommended
                  </span>
                ) : aboveLink ? (
                  <span className="preset__tag">Above your link</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </Popover>

      <Popover open={panel === 'more'} title="More" className="dock-panel">
        <div className="stack" style={{ ['--gap' as string]: '2px' }}>
          {/* On a narrow screen the quality and volume buttons live here. */}
          <div className="dock-more-compact">
            {showQuality && onQualityChange && (
              <button type="button" className="menu-item" onClick={() => setPanel('quality')}>
                <QualityIcon size={18} />
                <span className="menu-item__label">Stream quality</span>
              </button>
            )}
            <button type="button" className="menu-item" onClick={() => setPanel('voice')} disabled={!hasVoiceControls}>
              <VolumeIcon size={18} />
              <span className="menu-item__label">Volume</span>
            </button>
          </div>
          {moreItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className="menu-item"
              aria-pressed={item.pressed}
              disabled={item.disabled}
              onClick={() => {
                item.onSelect();
                setPanel(null);
              }}
            >
              {item.icon}
              <span className="menu-item__label">
                {item.label}
                {item.hint && <span className="menu-item__hint">{item.hint}</span>}
              </span>
              {item.pressed !== undefined && <span className="menu-item__state">{item.pressed ? 'On' : 'Off'}</span>}
            </button>
          ))}
          {moreItems.length === 0 && <p className="muted">Nothing else here right now.</p>}
        </div>
      </Popover>
    </div>
  );
}

/**
 * Two icons that trade places with a quick rotate-and-fade — the mic slash
 * does not just appear, it is drawn in.
 */
function SwapIcon({ on, onIcon, offIcon }: { on: boolean; onIcon: ReactNode; offIcon: ReactNode }) {
  return (
    <m.span
      key={on ? 'on' : 'off'}
      initial={{ opacity: 0, rotate: -30, scale: 0.6 }}
      animate={{ opacity: 1, rotate: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 500, damping: 26 }}
      style={{ display: 'grid' }}
    >
      {on ? onIcon : offIcon}
    </m.span>
  );
}

function VolumeSlider({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <label className="slider-row">
      <span className="slider-row__head">
        <span>{label}</span>
        <output>{value}%</output>
      </span>
      <input
        type="range"
        className="range"
        min={0}
        max={100}
        value={value}
        style={{ ['--fill' as string]: `${value}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

/**
 * The live readout: both halves of the picture, so a bug report can say which
 * end gave up. Every line is guarded on its own — a partial reading still
 * carries information, and an all-or-nothing gate made one indistinguishable
 * from no connection at all.
 */
function Diagnostics({
  uplink,
  diagnostics,
  appliedPoint,
  atBudgetFloor,
  inbound,
  peerShare,
}: Pick<MediaControlsProps, 'uplink' | 'diagnostics' | 'appliedPoint' | 'atBudgetFloor' | 'inbound' | 'peerShare'>) {
  if (!(uplink || diagnostics?.path || diagnostics?.outbound || inbound || peerShare)) return null;
  const jitter = inbound ? jitterBufferMs(inbound) : null;
  return (
    <div className="stats">
      {/* "≥" and not "=" when the number is a measured lower bound rather than
          a capacity estimate — on a TCP relay `availableOutgoingBitrate`
          describes TCP, not the path. Showing 0.0 Mbps there is how a 200 Mbps
          link got reported as having no bandwidth. */}
      {uplink && (
        <Stat k="Uplink">
          {uplink.capacityKnown ? '' : '≥ '}
          {uplink.uplinkMbps} Mbps{!uplink.capacityKnown && ', no capacity estimate on this path'}
        </Stat>
      )}
      {diagnostics?.path && (
        <Stat k="Path" note={diagnostics.path.isRelayed}>
          {formatTransportPath(diagnostics.path)}
          {diagnostics.path.rttMs !== null && `, ${diagnostics.path.rttMs} ms`}
        </Stat>
      )}
      {diagnostics?.outbound && (
        <Stat k="Sending">
          {diagnostics.outbound.frameWidth != null
            ? `${diagnostics.outbound.frameWidth}×${diagnostics.outbound.frameHeight}`
            : '—'}
          {diagnostics.outbound.framesPerSecond != null && ` @ ${Math.round(diagnostics.outbound.framesPerSecond)}`}
          {diagnostics.outbound.targetBitrate != null &&
            `, ${(diagnostics.outbound.targetBitrate / 1_000_000).toFixed(2)} Mbps`}
          {diagnostics.bpp != null && `, ${diagnostics.bpp.toFixed(3)} bpp`}
          {/* Software or hardware, in one string. 'libvpx-vp9' on a machine
              with no hardware VP9 encoder is the whole explanation for a share
              that stops and starts. */}
          {diagnostics.outbound.encoderImplementation && `, ${diagnostics.outbound.encoderImplementation}`}
        </Stat>
      )}
      {/* What we asked for, beside what came back. A collapsed frame rate
          INFLATES bits-per-pixel, so only the gap against the ask makes that
          readable as a failure. */}
      {appliedPoint && (
        <Stat k="Asked" warn={atBudgetFloor}>
          {appliedPoint.width}×{appliedPoint.height} @ {appliedPoint.fps}, {(appliedPoint.videoBps / 1_000_000).toFixed(2)}{' '}
          Mbps{atBudgetFloor && ', at floor'}
        </Stat>
      )}
      {diagnostics?.outbound?.qualityLimitationReason && diagnostics.outbound.qualityLimitationReason !== 'none' && (
        <Stat k="Limited by" warn>
          {diagnostics.outbound.qualityLimitationReason}
        </Stat>
      )}
      {/* The viewer's half. Everything above describes the local encoder,
          which is exactly the wrong end when the person reporting the fault is
          the one watching. */}
      {inbound && (
        <Stat k="Receiving">
          {inbound.frameWidth != null ? `${inbound.frameWidth}×${inbound.frameHeight}` : '—'}
          {inbound.framesPerSecond != null && ` @ ${Math.round(inbound.framesPerSecond)}`}
          {inbound.decoderImplementation && `, ${inbound.decoderImplementation}`}
        </Stat>
      )}
      {/* Freezing is the symptom nothing else in this panel can show. */}
      {inbound?.freezeCount != null && (
        <Stat k="Freezes" warn={inbound.freezeCount > 0}>
          {inbound.freezeCount}
          {inbound.totalFreezesDuration != null && ` (${inbound.totalFreezesDuration.toFixed(1)} s)`}
          {jitter != null && `, buffer ${Math.round(jitter)} ms`}
          {inbound.framesDropped != null && `, dropped ${inbound.framesDropped}`}
        </Stat>
      )}
      {/* Recovery traffic. A PLI is a keyframe we had to ask for, which is
          what a freeze ends with — so these separate "the picture stalled"
          from "the link is lossy". */}
      {(inbound?.pliCount != null || inbound?.nackCount != null) && (
        <Stat k="Recovery">
          {inbound.pliCount ?? '—'} PLI, {inbound.nackCount ?? '—'} NACK
        </Stat>
      )}
      {/* And what the far end says it is doing, so the two halves of the
          diagnosis finally sit on one screen. */}
      {peerShare && (
        <>
          <Stat k="Their encoder" warn={!!peerShare.limitedBy && peerShare.limitedBy !== 'none'}>
            {peerShare.encoder ?? 'unknown'}
            {peerShare.limitedBy && peerShare.limitedBy !== 'none' && `, limited by ${peerShare.limitedBy}`}
          </Stat>
          <Stat k="Their ask">
            {peerShare.width}×{peerShare.height} @ {peerShare.fps}, {(peerShare.bps / 1_000_000).toFixed(2)} Mbps
          </Stat>
          {/* Beside the ask, because the gap between the two is the answer
              whenever this side is freezing: frames that were never made
              cannot have been lost. */}
          {peerShare.sentFps !== undefined && (
            <Stat k="They send">
              {Math.round(peerShare.sentFps)} fps
              {peerShare.sentFps < peerShare.fps * SOURCE_IDLE_FPS_RATIO && ', their screen is still'}
            </Stat>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ k, children, warn, note }: { k: string; children: ReactNode; warn?: boolean; note?: boolean }) {
  return (
    <div className="stats__row">
      <span className="stats__key">{k}</span>
      <span className="stats__val" data-warn={warn ? '' : undefined} data-note={note ? '' : undefined}>
        {children}
      </span>
    </div>
  );
}

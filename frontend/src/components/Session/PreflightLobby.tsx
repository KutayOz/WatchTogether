import { logger } from '../../services/logger';
import { useEffect, useRef, useState } from 'react';
import {
  Sketchbook,
  SectionTitle,
  StickerButton,
  BackButton,
  BurstSticker,
  TagSticker,
  Doodle,
} from '../manga';

/**
 * Pre-flight lobby — the room before The Room.
 *
 * The user picks devices, sees their own preview, watches their mic level move,
 * and only THEN commits to joining the actual call. This is the modern
 * Zoom/Meet/Whereby pattern. Two reasons it matters:
 *
 *   1. Permission grant happens here, not after signaling has half-wired up.
 *      If the user denies camera in mid-join we used to land them in a broken
 *      session room; now they bounce off this screen with a clear hint.
 *
 *   2. They can verify the right camera/mic are selected before the peer
 *      sees their face. Hot-swap (USB plug-in) is handled live.
 *
 * Lifecycle ownership: this component owns the MediaStream end-to-end while
 * mounted. Tracks are stopped on unmount UNLESS the user hit JOIN — in that
 * case we hand the stream off to SessionRoom via onReady(stream) and SessionRoom
 * passes it into webrtcService.attachLocalStream(). The PreflightLobby's stream
 * ref is cleared so the unmount cleanup doesn't pull the rug from under
 * SessionRoom.
 */

/** Initial mute/camera state captured from the lobby — the session room applies
 *  these via the same toggle path it uses for the in-call mute/camera buttons,
 *  so the camera LED honestly extinguishes (Stretch 16 pipeline) and the UI
 *  reflects the chosen state the instant the user lands in the room. */
export interface PreflightInitialState {
  micOff: boolean;
  camOff: boolean;
}

interface PreflightLobbyProps {
  /** Called once the user has consented + picked devices and clicks JOIN.
   *  Caller MUST take ownership of the stream — Preflight will not stop it.
   *  The optional `initial` describes what the user pre-toggled in the lobby
   *  (mic muted / camera off); the caller is responsible for actually applying
   *  it (e.g. via the session-room toggle pipeline). */
  onReady: (stream: MediaStream, initial: PreflightInitialState) => void;
  onCancel: () => void;
  /** Optional context line displayed in the header (e.g. "joining alice's session"). */
  contextHint?: string;
}

type PermissionError =
  | { kind: 'denied'; message: string }
  | { kind: 'no-device'; message: string }
  | { kind: 'in-use'; message: string }
  | { kind: 'other'; message: string };

interface DeviceLists {
  cameras: MediaDeviceInfo[];
  microphones: MediaDeviceInfo[];
}

export function PreflightLobby({ onReady, onCancel, contextHint }: PreflightLobbyProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // We track if the user committed (hit JOIN) so the unmount cleanup
  // doesn't stop tracks we just handed off to the call.
  const handedOffRef = useRef(false);

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [permError, setPermError] = useState<PermissionError | null>(null);
  const [acquiring, setAcquiring] = useState(true);
  const [devices, setDevices] = useState<DeviceLists>({ cameras: [], microphones: [] });
  const [selectedCamId, setSelectedCamId] = useState<string | undefined>();
  const [selectedMicId, setSelectedMicId] = useState<string | undefined>();
  const [audioLevel, setAudioLevel] = useState(0);

  // Pre-join mic / camera toggles. These flip track.enabled on the live stream
  // (fast, no re-acquire) just to give the user visual confirmation in the
  // preview — the LED can stay on briefly here because the user is already
  // intentionally previewing themselves. The strict "stop + replaceTrack(null)"
  // privacy pipeline runs at JOIN time (SessionRoom applies the initial state
  // through its existing toggle pipeline).
  const [micOff, setMicOff] = useState(false);
  const [camOff, setCamOff] = useState(false);

  // Apply the current micOff/camOff state to whatever tracks live on `s`.
  // Pulled out so the device-swap path can re-apply user intent — otherwise
  // hot-swapping a mic while muted would silently un-mute the user.
  const applyTrackState = (s: MediaStream, micOffNow: boolean, camOffNow: boolean) => {
    s.getAudioTracks().forEach((t) => { t.enabled = !micOffNow; });
    s.getVideoTracks().forEach((t) => { t.enabled = !camOffNow; });
  };

  // ── Initial acquisition ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = s;
        setStream(s);
        setAcquiring(false);

        // Now that permission is granted, device labels become available.
        await refreshDevices();
        // Pre-select whatever the browser actually gave us so the dropdowns
        // reflect reality, not a guess.
        const camTrack = s.getVideoTracks()[0];
        const micTrack = s.getAudioTracks()[0];
        setSelectedCamId(camTrack?.getSettings().deviceId);
        setSelectedMicId(micTrack?.getSettings().deviceId);
      } catch (err: unknown) {
        if (cancelled) return;
        setAcquiring(false);
        setPermError(classifyError(err));
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Unmount cleanup — stop tracks UNLESS handed off ────────────────────
  useEffect(() => {
    return () => {
      if (!handedOffRef.current && streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  // ── Attach stream to <video> preview ───────────────────────────────────
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  // ── Audio level meter (Web Audio AnalyserNode, RMS over 256 samples) ──
  useEffect(() => {
    if (!stream) return;
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) return;

    let raf = 0;
    let closed = false;
    // AudioContext can throw on Safari if user hasn't interacted yet — but by
    // the time we're here, getUserMedia has resolved which counts as a gesture.
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      if (closed) return;
      analyser.getByteTimeDomainData(buf);
      let sumSquares = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sumSquares += v * v;
      }
      // RMS is usually 0-0.3 even for loud speech, so we scale by 3x to make
      // a meter that actually fills. Cap at 1 so a shout doesn't bleed off.
      const rms = Math.min(1, Math.sqrt(sumSquares / buf.length) * 3);
      setAudioLevel(rms);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      closed = true;
      cancelAnimationFrame(raf);
      source.disconnect();
      ctx.close().catch(() => {});
    };
  }, [stream]);

  // ── enumerateDevices + hot-swap listener ───────────────────────────────
  const refreshDevices = async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices({
        cameras: list.filter((d) => d.kind === 'videoinput'),
        microphones: list.filter((d) => d.kind === 'audioinput'),
      });
    } catch (err) {
      logger.warn('[Preflight] enumerateDevices failed:', err);
    }
  };

  useEffect(() => {
    const onChange = () => {
      refreshDevices();
    };
    navigator.mediaDevices.addEventListener?.('devicechange', onChange);
    return () => navigator.mediaDevices.removeEventListener?.('devicechange', onChange);
  }, []);

  // ── Device swap: replace tracks on the SAME stream id where possible ──
  const replaceStream = async (newCamId?: string, newMicId?: string) => {
    try {
      const constraints: MediaStreamConstraints = {
        video: newCamId ? { deviceId: { exact: newCamId } } : true,
        audio: newMicId
          ? { deviceId: { exact: newMicId }, echoCancellation: true, noiseSuppression: true }
          : { echoCancellation: true, noiseSuppression: true },
      };
      const next = await navigator.mediaDevices.getUserMedia(constraints);
      // Stop the previous stream's tracks BEFORE swapping — otherwise the
      // camera light stays on for both, which freaks people out.
      streamRef.current?.getTracks().forEach((t) => t.stop());
      // Carry user intent across the swap: fresh tracks are enabled by default,
      // so we re-mute / re-disable to match whatever the toggles are showing.
      applyTrackState(next, micOff, camOff);
      streamRef.current = next;
      setStream(next);
      setSelectedCamId(next.getVideoTracks()[0]?.getSettings().deviceId);
      setSelectedMicId(next.getAudioTracks()[0]?.getSettings().deviceId);
    } catch (err) {
      logger.warn('[Preflight] device swap failed:', err);
      setPermError(classifyError(err));
    }
  };

  const handleJoin = () => {
    if (!streamRef.current) return;
    handedOffRef.current = true;
    onReady(streamRef.current, { micOff, camOff });
  };

  // Toggle handlers — flip state + apply enabled to the live tracks so the
  // preview reacts instantly. We keep the tracks alive (not stop()) so the
  // user can toggle back on without paying a getUserMedia re-acquire cost.
  const toggleMicOff = () => {
    setMicOff((prev) => {
      const next = !prev;
      if (streamRef.current) {
        streamRef.current.getAudioTracks().forEach((t) => { t.enabled = !next; });
      }
      return next;
    });
  };

  const toggleCamOff = () => {
    setCamOff((prev) => {
      const next = !prev;
      if (streamRef.current) {
        streamRef.current.getVideoTracks().forEach((t) => { t.enabled = !next; });
      }
      return next;
    });
  };

  const handleRetry = async () => {
    setPermError(null);
    setAcquiring(true);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = s;
      setStream(s);
      await refreshDevices();
    } catch (err) {
      setPermError(classifyError(err));
    } finally {
      setAcquiring(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <div className="screen" style={{ display: 'grid', placeItems: 'center', padding: '20px 0', minHeight: '100vh' }}>
        <Sketchbook style={{ width: '100%', maxWidth: 920 }}>
          <div style={{ marginBottom: 18, position: 'relative' }}>
            <SectionTitle size={48} underline="pink">
              READY TO PARTY?
            </SectionTitle>
            <div style={{ position: 'absolute', right: 0, top: -4 }}>
              <TagSticker color="purple" rot={6}>
                CHECK IT
              </TagSticker>
            </div>
            {contextHint && (
              <div className="hand" style={{ fontSize: 20, marginTop: 12, color: 'rgba(26,20,23,0.7)' }}>
                {contextHint}
              </div>
            )}
          </div>

          {permError ? (
            <PermissionDeniedBlock error={permError} onRetry={handleRetry} onCancel={onCancel} />
          ) : (
            <div className="preflight-grid">
              {/* LEFT — preview */}
              <PreviewBox
                videoRef={videoRef}
                hasStream={!!stream}
                acquiring={acquiring}
                camOff={camOff}
                micOff={micOff}
              />

              {/* RIGHT — meter + toggles + pickers */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
                <AudioMeter level={audioLevel} active={!!stream} muted={micOff} />

                <JoinToggles
                  micOff={micOff}
                  camOff={camOff}
                  onToggleMic={toggleMicOff}
                  onToggleCam={toggleCamOff}
                  disabled={acquiring || !stream}
                />

                <DeviceSelect
                  label="camera:"
                  devices={devices.cameras}
                  value={selectedCamId}
                  onChange={(id) => replaceStream(id, selectedMicId)}
                  disabled={acquiring || !stream}
                />

                <DeviceSelect
                  label="microphone:"
                  devices={devices.microphones}
                  value={selectedMicId}
                  onChange={(id) => replaceStream(selectedCamId, id)}
                  disabled={acquiring || !stream}
                />
              </div>
            </div>
          )}

          {/* Actions */}
          {!permError && (
            <div
              className="row"
              style={{ gap: 16, marginTop: 24, flexWrap: 'wrap', alignItems: 'center' }}
            >
              <StickerButton
                color="pink"
                size="xl"
                sfx="TAP!"
                sparks
                breathe
                disabled={acquiring || !stream}
                onClick={handleJoin}
              >
                {acquiring
                  ? 'WAITING…'
                  : micOff && camOff
                  ? 'JOIN QUIETLY'
                  : micOff
                  ? 'JOIN MUTED'
                  : camOff
                  ? 'JOIN CAM-OFF'
                  : 'JOIN!'}
              </StickerButton>
              <BackButton onClick={onCancel}>nevermind</BackButton>
              <div className="hand" style={{ fontSize: 16, color: 'rgba(26,20,23,0.55)', marginLeft: 'auto' }}>
                <Doodle kind="heart" size={18} color="var(--pink)" />{' '}
                {micOff && camOff
                  ? 'you\'ll arrive invisible'
                  : micOff
                  ? 'you\'ll arrive muted'
                  : camOff
                  ? 'you\'ll arrive camera-off'
                  : 'the peer hasn\'t seen you yet'}
              </div>
            </div>
          )}
        </Sketchbook>
      </div>

      {/* Grid breakpoint kept inline — small enough to live with the component. */}
      <style>{`
        .preflight-grid {
          display: grid;
          grid-template-columns: minmax(280px, 1.4fr) minmax(220px, 1fr);
          gap: 24px;
        }
        @media (max-width: 720px) {
          .preflight-grid { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Sub-components                                                  */
/* ────────────────────────────────────────────────────────────── */

function PreviewBox({
  videoRef,
  hasStream,
  acquiring,
  camOff,
  micOff,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  hasStream: boolean;
  acquiring: boolean;
  camOff: boolean;
  micOff: boolean;
}) {
  return (
    <div
      style={{
        position: 'relative',
        border: '4px solid var(--ink)',
        borderRadius: 6,
        background: 'var(--cream-deep)',
        boxShadow: '6px 6px 0 var(--purple)',
        aspectRatio: '4 / 3',
        overflow: 'hidden',
        transform: 'rotate(-1deg)',
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
          // Selfie convention: mirror the preview so the user sees themselves
          // like in a mirror, not like a doppelganger.
          transform: 'scaleX(-1)',
          opacity: hasStream ? 1 : 0,
        }}
      />
      {!hasStream && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'var(--cream-deep)' }}>
          <div style={{ textAlign: 'center' }}>
            <Doodle kind="z" size={36} color="rgba(26,20,23,0.45)" />
            <div className="hand" style={{ fontSize: 18, color: 'rgba(26,20,23,0.6)', marginTop: 6 }}>
              {acquiring ? 'asking for permission…' : 'no preview yet'}
            </div>
          </div>
        </div>
      )}
      {/* Camera-off overlay — blanks out the preview without removing the
          video element, so re-enabling is instant. Uses the same cream-deep
          background as the empty state for visual continuity. */}
      {hasStream && camOff && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            background: 'var(--cream-deep)',
          }}
        >
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--font-sfx)', fontSize: 30, letterSpacing: 2, color: 'var(--ink)' }}>
              CAMERA OFF
            </div>
            <div className="hand" style={{ fontSize: 16, color: 'rgba(26,20,23,0.6)', marginTop: 6 }}>
              your peer won't see you
            </div>
          </div>
        </div>
      )}
      {/* Bottom-right "muted" chip — only appears when mic is pre-muted, so the
          user has a constant visual reminder before they hit JOIN. */}
      {hasStream && micOff && (
        <div
          style={{
            position: 'absolute',
            right: 8,
            bottom: 8,
            background: 'var(--orange)',
            border: '3px solid var(--ink)',
            padding: '3px 10px',
            fontFamily: 'var(--font-sfx)',
            fontSize: 13,
            letterSpacing: 1,
            color: 'var(--ink)',
            transform: 'rotate(2deg)',
          }}
        >
          MIC OFF
        </div>
      )}
      <div
        style={{
          position: 'absolute',
          left: 8,
          bottom: 8,
          background: 'var(--cream)',
          border: '3px solid var(--ink)',
          padding: '3px 10px',
          fontFamily: 'var(--font-sfx)',
          fontSize: 13,
          letterSpacing: 1,
          transform: 'rotate(-2deg)',
        }}
      >
        you (preview)
      </div>
    </div>
  );
}

function AudioMeter({ level, active, muted }: { level: number; active: boolean; muted: boolean }) {
  // 12 segments — looks meaty without being computationally silly.
  const segments = 12;
  // When pre-muted we still want to *show* the meter (people glance to know
  // their mic exists), but never light it up — flipping segments while the
  // top-right says "muted" is confusing.
  const filled = muted ? 0 : Math.round(level * segments);
  return (
    <div
      style={{
        border: '3px solid var(--ink)',
        background: 'var(--cream)',
        boxShadow: '4px 4px 0 var(--pink)',
        padding: '10px 12px',
        transform: 'rotate(0.5deg)',
        opacity: muted ? 0.7 : 1,
        transition: 'opacity 150ms ease',
      }}
    >
      <div
        className="hand"
        style={{
          fontSize: 16,
          color: 'var(--purple)',
          marginBottom: 6,
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>mic level</span>
        <span style={{ color: muted ? 'var(--orange-deep, var(--orange))' : active ? 'var(--purple)' : 'rgba(26,20,23,0.4)' }}>
          {muted ? 'muted' : active ? 'live' : '—'}
        </span>
      </div>
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={muted ? 0 : level}
        aria-label="microphone input level"
        style={{ display: 'flex', gap: 3, height: 18 }}
      >
        {Array.from({ length: segments }).map((_, i) => {
          // Color ramps from pink (quiet) through purple (mid) to orange (loud)
          // so the user can tell when they're peaking even without numbers.
          const isOn = i < filled && active;
          const color =
            i >= segments - 2 ? 'var(--orange)' :
            i >= segments / 2 ? 'var(--purple)' :
            'var(--pink)';
          return (
            <div
              key={i}
              style={{
                flex: 1,
                background: isOn ? color : 'rgba(26,20,23,0.08)',
                border: '1.5px solid rgba(26,20,23,0.25)',
                transition: 'background 60ms linear',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * Two big toggle pills for joining muted / camera-off. Sketchbook-styled to
 * match the rest of the lobby — when "off", the pill flips to an orange
 * background with a hand-drawn strikethrough on the icon so the state is
 * obvious from across the room.
 */
function JoinToggles({
  micOff,
  camOff,
  onToggleMic,
  onToggleCam,
  disabled,
}: {
  micOff: boolean;
  camOff: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  disabled: boolean;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 10,
      }}
    >
      <ToggleTile
        label={micOff ? 'mic off' : 'mic on'}
        sub={micOff ? 'tap to unmute' : 'tap to mute'}
        active={!micOff}
        glyph="mic"
        onClick={onToggleMic}
        disabled={disabled}
        ariaLabel="toggle microphone before joining"
        ariaPressed={micOff}
      />
      <ToggleTile
        label={camOff ? 'cam off' : 'cam on'}
        sub={camOff ? 'tap to enable' : 'tap to hide'}
        active={!camOff}
        glyph="cam"
        onClick={onToggleCam}
        disabled={disabled}
        ariaLabel="toggle camera before joining"
        ariaPressed={camOff}
      />
    </div>
  );
}

function ToggleTile({
  label,
  sub,
  active,
  glyph,
  onClick,
  disabled,
  ariaLabel,
  ariaPressed,
}: {
  label: string;
  sub: string;
  active: boolean;
  glyph: 'mic' | 'cam';
  onClick: () => void;
  disabled: boolean;
  ariaLabel: string;
  ariaPressed: boolean;
}) {
  // Active (= on) tile is purple-shadowed cream — same family as the audio
  // meter. Off tile flips to orange-on-cream with a strikethrough — same
  // visual language as the camera/mic indicators in the live session
  // sidebar, so the user encounters it again later in the same shape.
  const shadow = active ? '4px 4px 0 var(--purple)' : '4px 4px 0 var(--orange)';
  const bg = active ? 'var(--cream)' : 'rgba(244,160,76,0.18)';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      style={{
        position: 'relative',
        textAlign: 'left',
        border: '3px solid var(--ink)',
        background: bg,
        boxShadow: shadow,
        padding: '10px 12px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'transform 80ms ease, box-shadow 80ms ease, background 150ms ease',
        transform: 'rotate(-0.4deg)',
        fontFamily: 'inherit',
      }}
      onMouseDown={(e) => {
        // Stamp-press feedback — drop the shadow + nudge so it feels like
        // pressing a sticker. Matches StickerButton's interaction feel.
        e.currentTarget.style.transform = 'translate(2px,2px) rotate(-0.4deg)';
        e.currentTarget.style.boxShadow = active ? '2px 2px 0 var(--purple)' : '2px 2px 0 var(--orange)';
      }}
      onMouseUp={(e) => {
        e.currentTarget.style.transform = 'rotate(-0.4deg)';
        e.currentTarget.style.boxShadow = shadow;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'rotate(-0.4deg)';
        e.currentTarget.style.boxShadow = shadow;
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <ToggleGlyph kind={glyph} active={active} />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontFamily: 'var(--font-sfx)',
              fontSize: 16,
              letterSpacing: 1,
              color: 'var(--ink)',
              textTransform: 'uppercase',
            }}
          >
            {label}
          </div>
          <div className="hand" style={{ fontSize: 13, color: 'rgba(26,20,23,0.55)', marginTop: 2 }}>
            {sub}
          </div>
        </div>
      </div>
    </button>
  );
}

/**
 * Hand-drawn mic / camera glyphs with a strikethrough when off. Inline SVGs
 * keep them crisp at any zoom and let us style with the same ink/orange tokens
 * the rest of the manga UI uses (avoids an icon-font dep).
 */
function ToggleGlyph({ kind, active }: { kind: 'mic' | 'cam'; active: boolean }) {
  const stroke = active ? 'var(--ink)' : 'var(--ink)';
  return (
    <svg
      width={34}
      height={34}
      viewBox="0 0 34 34"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {kind === 'mic' ? (
        <>
          {/* Mic capsule */}
          <rect x="13" y="6" width="8" height="14" rx="4" stroke={stroke} strokeWidth="2.4" />
          {/* Stand arc */}
          <path d="M9 16 Q9 24 17 24 Q25 24 25 16" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" fill="none" />
          {/* Base */}
          <line x1="17" y1="24" x2="17" y2="29" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" />
          <line x1="12" y1="29" x2="22" y2="29" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" />
        </>
      ) : (
        <>
          {/* Camera body */}
          <rect x="5" y="10" width="18" height="14" rx="2" stroke={stroke} strokeWidth="2.4" />
          {/* Lens */}
          <polygon points="23,14 30,10 30,24 23,20" stroke={stroke} strokeWidth="2.4" strokeLinejoin="round" />
        </>
      )}
      {/* Strikethrough when off — drawn slightly skewed for a hand-inked feel. */}
      {!active && (
        <line
          x1="4"
          y1="30"
          x2="30"
          y2="4"
          stroke="var(--orange)"
          strokeWidth="3"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

function DeviceSelect({
  label,
  devices,
  value,
  onChange,
  disabled,
}: {
  label: string;
  devices: MediaDeviceInfo[];
  value: string | undefined;
  onChange: (deviceId: string) => void;
  disabled: boolean;
}) {
  return (
    <label style={{ display: 'block' }}>
      <span
        className="hand"
        style={{ display: 'block', fontSize: 18, color: 'var(--purple)', marginBottom: 4 }}
      >
        {label}
      </span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || devices.length === 0}
        style={{
          width: '100%',
          border: '3px solid var(--ink)',
          background: 'var(--cream)',
          padding: '8px 10px',
          fontFamily: 'var(--font-body)',
          fontSize: 15,
          color: 'var(--ink)',
          boxShadow: '3px 3px 0 var(--ink)',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {devices.length === 0 && <option>no devices found</option>}
        {devices.map((d, i) => (
          <option key={d.deviceId || i} value={d.deviceId}>
            {d.label || `device ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}

function PermissionDeniedBlock({
  error,
  onRetry,
  onCancel,
}: {
  error: PermissionError;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const tips: Record<PermissionError['kind'], string> = {
    denied:
      'open your browser site settings (the lock icon next to the URL) and allow camera + microphone.',
    'no-device':
      'we couldn\'t find any camera or microphone. plug something in and try again.',
    'in-use':
      'something else is using your camera (zoom, another tab, OBS…). close it and try again.',
    other: 'try again, or refresh the page.',
  };
  return (
    <div style={{ textAlign: 'center', padding: '12px 0 24px' }}>
      <BurstSticker bg="var(--orange)" rot={-3} w={260} h={150}>
        NEED ACCESS
      </BurstSticker>
      <p className="hand" style={{ fontSize: 22, marginTop: 18, color: 'var(--ink)' }}>
        {error.message}
      </p>
      <p className="hand" style={{ fontSize: 18, marginTop: 6, color: 'rgba(26,20,23,0.65)', maxWidth: 540, marginLeft: 'auto', marginRight: 'auto' }}>
        {tips[error.kind]}
      </p>
      <div className="row" style={{ justifyContent: 'center', gap: 14, marginTop: 22, flexWrap: 'wrap' }}>
        <StickerButton color="pink" size="md" sfx="TAP!" onClick={onRetry}>
          TRY AGAIN
        </StickerButton>
        <BackButton onClick={onCancel}>back to lobby</BackButton>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Helpers                                                         */
/* ────────────────────────────────────────────────────────────── */

/**
 * getUserMedia throws a small zoo of error names. We map them to the four
 * user-actionable buckets so the UI can show a meaningful hint without
 * leaking the underlying DOMException name.
 */
function classifyError(err: unknown): PermissionError {
  const e = err as { name?: string; message?: string };
  const name = e?.name ?? '';
  const message = e?.message ?? 'something went wrong';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return { kind: 'denied', message: 'camera + mic access was denied.' };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return { kind: 'no-device', message: 'no camera or microphone found.' };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return { kind: 'in-use', message: 'your camera or mic is busy.' };
  }
  return { kind: 'other', message };
}

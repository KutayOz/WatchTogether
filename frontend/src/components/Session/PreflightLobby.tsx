import { logger } from '../../services/logger';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { Button } from '../ui/Button';
import { FocusText } from '../ui/FocusText';
import { AlertIcon, ArrowLeftIcon, CamIcon, CamOffIcon, MicIcon, MicOffIcon, PlayIcon } from '../ui/icons';
import { ease } from '../ui/motion';
import { useScene } from '../ui/useScene';
import { useAmbientLight } from '../../hooks/useAmbientLight';
import './session.css';

/**
 * Pre-flight lobby — the room before The Room.
 *
 * The user picks devices, sees their own preview, watches their mic move,
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
  useScene('theater');
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
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

  // Pre-join mic / camera toggles. These flip track.enabled on the live stream
  // (fast, no re-acquire) just to give the user visual confirmation in the
  // preview — the LED can stay on briefly here because the user is already
  // intentionally previewing themselves. The strict "stop + replaceTrack(null)"
  // privacy pipeline runs at JOIN time (SessionRoom applies the initial state
  // through its existing toggle pipeline).
  const [micOff, setMicOff] = useState(false);
  const [camOff, setCamOff] = useState(false);

  // Your own picture lights the room around the preview.
  useAmbientLight(previewRef, !!stream && !camOff);

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

  const joinLabel = acquiring
    ? 'Waiting for your camera…'
    : micOff && camOff
      ? 'Join muted, camera off'
      : micOff
        ? 'Join muted'
        : camOff
          ? 'Join with camera off'
          : 'Join';

  const joinNote =
    micOff && camOff
      ? 'You’ll arrive muted and with your camera off.'
      : micOff
        ? 'You’ll arrive muted.'
        : camOff
          ? 'You’ll arrive with your camera off.'
          : 'Nobody can see or hear you until you join.';

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="preflight">
      <header className="preflight__top">
        <Button variant="ghost" size="sm" icon={<ArrowLeftIcon size={18} />} onClick={onCancel}>
          Back to lobby
        </Button>
        {contextHint && <span className="chip">{contextHint}</span>}
      </header>

      <main className="preflight__main">
        <div className="preflight__intro">
          <FocusText as="h1" text="Check your picture and sound" delay={0.1} stagger={0.06} />
          <m.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5, duration: 0.6 }}>
            Pick your camera and mic, then join when you look right.
          </m.p>
        </div>

        {permError ? (
          <PermissionDeniedBlock error={permError} onRetry={handleRetry} onCancel={onCancel} />
        ) : (
          <div className="preflight__grid">
            <m.div
              ref={previewRef}
              className="preview stage-wrap"
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.6, ease: ease.out }}
            >
              <div className="stage-glow" aria-hidden="true" />
              <div className="preview__frame">
                <video
                  ref={videoRef}
                  data-ambient=""
                  autoPlay
                  playsInline
                  muted
                  // Selfie convention: mirrored, like a mirror.
                  style={{ opacity: stream && !camOff ? 1 : 0 }}
                />
                <AnimatePresence>
                  {(!stream || camOff) && (
                    <m.div
                      className="preview__state"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                    >
                      {!stream ? (
                        <>
                          <span className="btn__spinner" aria-hidden="true" style={{ width: 28, height: 28 }} />
                          <span>{acquiring ? 'Asking for your camera and mic…' : 'No preview yet'}</span>
                        </>
                      ) : (
                        <>
                          <CamOffIcon size={34} />
                          <strong>Camera off</strong>
                          <span>They won’t see you until you turn it on.</span>
                        </>
                      )}
                    </m.div>
                  )}
                </AnimatePresence>
              </div>
              <div className="preview__chips">
                <span className="chip chip--glass">You</span>
                {stream && micOff && (
                  <span className="chip chip--exit">
                    <MicOffIcon size={14} />
                    Mic off
                  </span>
                )}
              </div>
            </m.div>

            <m.div
              className="sheet preflight__controls"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: ease.out, delay: 0.15 }}
            >
              <MicWaveform stream={stream} muted={micOff} glowRef={previewRef} />

              <div className="switches">
                <SwitchTile
                  label="Microphone"
                  on={!micOff}
                  onText="On"
                  offText="Off, you’ll join muted"
                  icon={micOff ? <MicOffIcon size={20} /> : <MicIcon size={20} />}
                  onClick={toggleMicOff}
                  disabled={acquiring || !stream}
                />
                <SwitchTile
                  label="Camera"
                  on={!camOff}
                  onText="On"
                  offText="Off, they won’t see you"
                  icon={camOff ? <CamOffIcon size={20} /> : <CamIcon size={20} />}
                  onClick={toggleCamOff}
                  disabled={acquiring || !stream}
                />
              </div>

              <DeviceSelect
                label="Camera"
                devices={devices.cameras}
                value={selectedCamId}
                onChange={(id) => replaceStream(id, selectedMicId)}
                disabled={acquiring || !stream}
              />

              <DeviceSelect
                label="Microphone"
                devices={devices.microphones}
                value={selectedMicId}
                onChange={(id) => replaceStream(selectedCamId, id)}
                disabled={acquiring || !stream}
              />

              <div className="stack" style={{ ['--gap' as string]: '10px' }}>
                <Button
                  variant="primary"
                  size="lg"
                  block
                  magnetic
                  icon={<PlayIcon size={20} />}
                  loading={acquiring}
                  disabled={acquiring || !stream}
                  onClick={handleJoin}
                >
                  {joinLabel}
                </Button>
                <p className="muted" style={{ fontSize: '0.875rem', textAlign: 'center' }}>
                  {joinNote}
                </p>
              </div>
            </m.div>
          </div>
        )}
      </main>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Sub-components                                                  */
/* ────────────────────────────────────────────────────────────── */

const WAVE_FRAME_MS = 1000 / 30;

/**
 * The mic, as a live oscilloscope trace — you can see yourself talk. Drawn on
 * a canvas straight from an AnalyserNode, thirty times a second, without a
 * single React render: the old meter set state every animation frame and
 * re-rendered the whole lobby with it.
 *
 * The loudness also goes onto the preview as --level, so your picture glows
 * when you speak, and onto the meter's aria-valuenow a few times a second for
 * assistive tech.
 */
function MicWaveform({
  stream,
  muted,
  glowRef,
}: {
  stream: MediaStream | null;
  muted: boolean;
  glowRef: RefObject<HTMLElement | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const mutedRef = useRef(muted);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const audioTrack = stream?.getAudioTracks()[0];
    const glowEl = glowRef.current;
    if (!canvas || !ctx) return;

    const size = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(canvas);

    const drawFlat = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = 'rgba(246,238,230,0.18)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, canvas.height / 2);
      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();
    };

    if (!audioTrack) {
      drawFlat();
      return () => ro.disconnect();
    }

    // AudioContext can throw on Safari if user hasn't interacted yet — but by
    // the time we're here, getUserMedia has resolved which counts as a gesture.
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audio = new Ctor();
    const source = audio.createMediaStreamSource(new MediaStream([audioTrack]));
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let raf = 0;
    let last = 0;
    let lastAria = 0;
    let level = 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < WAVE_FRAME_MS) return;
      last = now;
      analyser.getByteTimeDomainData(buf);

      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      // RMS is usually 0-0.3 even for loud speech, so scale up to fill.
      const rms = mutedRef.current ? 0 : Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
      level = rms > level ? level + (rms - level) * 0.55 : level + (rms - level) * 0.12;
      glowEl?.style.setProperty('--level', level.toFixed(2));
      if (now - lastAria > 250 && meterRef.current) {
        lastAria = now;
        meterRef.current.setAttribute('aria-valuenow', level.toFixed(2));
      }

      if (mutedRef.current || reduce) {
        drawFlat();
        return;
      }
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const gradient = ctx.createLinearGradient(0, 0, w, 0);
      gradient.addColorStop(0, 'rgba(255,181,71,0.25)');
      gradient.addColorStop(0.5, 'rgba(255,205,128,1)');
      gradient.addColorStop(1, 'rgba(255,181,71,0.25)');
      ctx.strokeStyle = gradient;
      ctx.lineWidth = Math.max(2, h / 28);
      ctx.lineJoin = 'round';
      ctx.shadowColor = 'rgba(255,181,71,0.8)';
      ctx.shadowBlur = 10 + level * 20;
      ctx.beginPath();
      const step = buf.length / w;
      for (let x = 0; x < w; x += 2) {
        const v = (buf[Math.floor(x * step)] - 128) / 128;
        // Taper toward the edges so the trace floats rather than clipping.
        const taper = Math.sin((x / w) * Math.PI);
        const y = h / 2 + v * (h / 2) * 1.6 * taper;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      source.disconnect();
      audio.close().catch(() => {});
      glowEl?.style.setProperty('--level', '0');
    };
  }, [stream, glowRef]);

  return (
    <div className="wave">
      <div className="wave__head">
        <span>Microphone</span>
        <span className={muted ? 'chip chip--exit' : stream ? 'chip chip--amber' : 'chip'}>
          {muted ? 'Muted' : stream ? 'Live' : 'Waiting'}
        </span>
      </div>
      <div ref={meterRef} role="meter" aria-label="Microphone input level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={0}>
        <canvas ref={canvasRef} className="wave__canvas" aria-hidden="true" />
      </div>
    </div>
  );
}

/**
 * A big on/off tile. A real switch to assistive tech: checked means on,
 * which is what "Microphone, switch, on" should mean.
 */
function SwitchTile({
  label,
  on,
  onText,
  offText,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  on: boolean;
  onText: string;
  offText: string;
  icon: ReactNode;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="switch-tile"
      onClick={onClick}
      disabled={disabled}
      data-ripple=""
    >
      <span className="switch-tile__icon" aria-hidden="true">
        <m.span
          key={on ? 'on' : 'off'}
          initial={{ opacity: 0, rotate: -25, scale: 0.6 }}
          animate={{ opacity: 1, rotate: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 480, damping: 24 }}
          style={{ display: 'grid' }}
        >
          {icon}
        </m.span>
      </span>
      <span className="switch-tile__text">
        <strong>{label}</strong>
        <small>{on ? onText : offText}</small>
      </span>
    </button>
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
  // An explicit for/id rather than a wrapping label: wrapped, the select's
  // accessible name swallowed the selected device name too.
  const id = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="select"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || devices.length === 0}
      >
        {devices.length === 0 && <option>No devices found</option>}
        {devices.map((d, i) => (
          <option key={d.deviceId || i} value={d.deviceId}>
            {d.label || `Device ${i + 1}`}
          </option>
        ))}
      </select>
    </div>
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
      'Open your browser’s site settings (the icon next to the address) and allow the camera and microphone, then try again.',
    'no-device': 'We couldn’t find a camera or microphone. Plug one in and try again.',
    'in-use': 'Something else is using your camera, like another tab, Zoom or OBS. Close it and try again.',
    other: 'Try again, or reload the page.',
  };
  return (
    <m.div className="sheet perm-block" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
      <span className="status-card__icon" aria-hidden="true">
        <AlertIcon size={28} />
      </span>
      <h2>We need your camera and mic</h2>
      <p>{error.message}</p>
      <p className="muted">{tips[error.kind]}</p>
      <div className="cluster" style={{ justifyContent: 'center' }}>
        <Button variant="ghost" onClick={onCancel}>
          Back to lobby
        </Button>
        <Button variant="primary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </m.div>
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
  const message = e?.message ?? 'Something went wrong.';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return { kind: 'denied', message: 'Camera and mic access was blocked.' };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return { kind: 'no-device', message: 'No camera or microphone found.' };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return { kind: 'in-use', message: 'Your camera or mic is busy.' };
  }
  return { kind: 'other', message };
}

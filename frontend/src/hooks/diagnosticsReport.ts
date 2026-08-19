import type { InboundScreenStats } from './useQualityMonitor';
import type { OperatingPoint } from './operatingPoint';
import type { SenderHealth } from './useSenderHealth';
import type { LogLine } from '../services/logBuffer';
import type {
  ContentMode,
  OutboundScreenStats,
  QualityLevel,
  ScreenShareQuality,
  ShareStatus,
  TransportPath,
  UplinkEstimate,
  Viewport,
} from '../types';

/**
 * A screen share failure, written down.
 *
 * Every number this app needs to explain a bad share already exists — the
 * transport path, the operating point, what the encoder achieved, what limited
 * it, what the receiver decoded, how often it froze. They exist on two
 * different machines, in a popover the viewer cannot even open while someone
 * else is sharing, for three seconds each, and then they are gone. So the only
 * report a user can actually make is "it looks choppy", which is how far the
 * last one got before somebody read the source for an afternoon.
 *
 * This turns that into text. Pure functions over data, no clock and no DOM, so
 * the shape of the output is a test rather than a screenshot — the same reason
 * `formatIceDiagnostics` is pure.
 */

/** One tick of everything, from whichever end recorded it. */
export interface DiagnosticsSnapshot {
  /** Milliseconds since the recording started. Relative, so it needs no clock. */
  atMs: number;
  path: TransportPath | null;
  uplink: UplinkEstimate | null;
  /** What we asked the encoder for, or null when not sharing. */
  point: OperatingPoint | null;
  /** What the encoder did with it. */
  outbound: OutboundScreenStats | null;
  bpp: number | null;
  senderHealth: SenderHealth;
  budgetBps: number | null;
  probing: boolean;
  capacityPixelsPerSecond: number | null;
  /** What we are decoding, when watching someone else's share. */
  inbound: InboundScreenStats | null;
  /** Our own verdict on what we are receiving. */
  level: QualityLevel | null;
  score: number | null;
  lossPercent: number | null;
  /** What the far end says about the picture we are sending them. */
  viewerLevel: QualityLevel | null;
  viewerViewport: Viewport | null;
  /** What the far end says about the picture they are sending us. */
  peerShare: ShareStatus | null;
}

/** The things that do not change every three seconds. */
export interface DiagnosticsHeader {
  generatedAt: string;
  sessionId: string | null;
  role: 'sharer' | 'viewer' | 'idle';
  userAgent: string;
  devicePixelRatio: number;
  quality: ScreenShareQuality;
  contentMode: ContentMode;
  codec: string;
  /** How big we are drawing the shared picture, in device pixels. */
  viewport: Viewport | null;
}

export interface DiagnosticsReport {
  header: DiagnosticsHeader;
  /** Oldest first. */
  samples: DiagnosticsSnapshot[];
  logs: LogLine[];
  /** `formatIceDiagnostics` output, when it was worth fetching. */
  ice: string | null;
}

/**
 * Timeline rows to print.
 *
 * The interesting window is the minute or two around the moment somebody
 * reached for this, not the whole session. Older samples are still held — and
 * the report SAYS how many it did not print, because a silent truncation reads
 * as "that is all there was".
 */
export const PRINTED_SAMPLES = 60;

const pad = (s: string, n: number) => s.padEnd(n);
const padStart = (s: string, n: number) => s.padStart(n);

/** Bits per second as Mbps to two places, or an em dash. */
function mbps(bps: number | null | undefined): string {
  return typeof bps === 'number' ? `${(bps / 1_000_000).toFixed(2)}M` : '—';
}

/** A picture as WxH@fps, from whichever shape carries those three. */
function geometry(
  width: number | null | undefined,
  height: number | null | undefined,
  fps: number | null | undefined,
): string {
  if (typeof width !== 'number' || typeof height !== 'number') return '—';
  const rate = typeof fps === 'number' ? `@${Math.round(fps)}` : '';
  return `${width}x${height}${rate}`;
}

/** Seconds, signed and relative to the end of the recording. */
function stamp(atMs: number, endMs: number): string {
  return `${Math.round((atMs - endMs) / 1000)}s`;
}

/** Mean milliseconds a frame waited in the jitter buffer. See jitterBufferMs. */
function bufferMs(s: InboundScreenStats | null): string {
  if (!s) return '—';
  const { jitterBufferDelay: delay, jitterBufferEmittedCount: emitted } = s;
  if (typeof delay !== 'number' || typeof emitted !== 'number' || emitted <= 0) return '—';
  return `${Math.round((delay / emitted) * 1000)}ms`;
}

function num(value: number | null | undefined, digits = 0): string {
  return typeof value === 'number' ? value.toFixed(digits) : '—';
}

/** "relayed (turn/tcp)" as a column-width token. */
function pathToken(path: TransportPath | null): string {
  if (!path) return '—';
  if (path.isRelayed) return `turn/${path.relayProtocol ?? path.protocol}`;
  return `p2p/${path.protocol}`;
}

/**
 * The sender's timeline.
 *
 * `asked` beside `sending` is the whole point of the table: a collapsed frame
 * rate INFLATES bits-per-pixel, so `344x182 @ 1 · 0.479 bpp` reads as excellent
 * quality until you see it next to what was requested.
 */
function senderTable(samples: DiagnosticsSnapshot[], endMs: number): string[] {
  const rows = samples.filter((s) => s.point || s.outbound);
  if (rows.length === 0) return [];

  const head =
    `${pad('t', 7)}${pad('path', 10)}${pad('asked', 16)}${pad('sending', 16)}` +
    `${pad('bpp', 7)}${pad('limit', 11)}${pad('health', 14)}${pad('budget', 8)}cap`;

  return [
    '',
    '— what this machine sent —',
    head,
    ...rows.map((s) => {
      const cap =
        s.capacityPixelsPerSecond === null
          ? '—'
          : `${(s.capacityPixelsPerSecond / 1_000_000).toFixed(1)}Mpx/s`;
      return (
        pad(stamp(s.atMs, endMs), 7) +
        pad(pathToken(s.path), 10) +
        pad(geometry(s.point?.width, s.point?.height, s.point?.fps), 16) +
        pad(
          geometry(
            s.outbound?.frameWidth,
            s.outbound?.frameHeight,
            s.outbound?.framesPerSecond,
          ),
          16,
        ) +
        pad(s.bpp === null ? '—' : s.bpp.toFixed(3), 7) +
        pad(s.outbound?.qualityLimitationReason ?? '—', 11) +
        pad(s.senderHealth + (s.probing ? '*' : ''), 14) +
        pad(mbps(s.budgetBps), 8) +
        cap
      );
    }),
    'asked vs sending is the tell; * on health means a probe was in flight',
  ];
}

/**
 * The receiver's timeline.
 *
 * Freezing is the one symptom only this end can see, and until this table
 * existed it was the one thing no diagnostic in the app reported.
 */
function receiverTable(samples: DiagnosticsSnapshot[], endMs: number): string[] {
  const rows = samples.filter((s) => s.inbound);
  if (rows.length === 0) return [];

  const head =
    `${pad('t', 7)}${pad('receiving', 16)}${pad('frz', 6)}${pad('frozen', 9)}` +
    `${pad('buffer', 9)}${pad('dropped', 9)}${pad('PLI', 6)}${pad('NACK', 7)}${pad('loss', 7)}level`;

  return [
    '',
    '— what this machine received —',
    head,
    ...rows.map((s) => {
      const i = s.inbound!;
      return (
        pad(stamp(s.atMs, endMs), 7) +
        pad(geometry(i.frameWidth, i.frameHeight, i.framesPerSecond), 16) +
        pad(num(i.freezeCount), 6) +
        pad(i.totalFreezesDuration === null ? '—' : `${i.totalFreezesDuration.toFixed(1)}s`, 9) +
        pad(bufferMs(i), 9) +
        pad(num(i.framesDropped), 9) +
        pad(num(i.pliCount), 6) +
        pad(num(i.nackCount), 7) +
        pad(s.lossPercent === null ? '—' : `${s.lossPercent.toFixed(1)}%`, 7) +
        (s.level ?? '—')
      );
    }),
    'frz and dropped are cumulative — read the change across rows, not the value',
  ];
}

/** The last sample, spelled out, for someone who reads only the top. */
function nowSection(last: DiagnosticsSnapshot | undefined): string[] {
  if (!last) return [];
  const lines: string[] = ['', '— the last sample, in full —'];

  if (last.path) {
    lines.push(
      `path        ${pathToken(last.path)}` +
        (last.path.rttMs === null ? '' : ` · ${last.path.rttMs} ms rtt`),
    );
  }
  if (last.uplink) {
    lines.push(
      `uplink      ${last.uplink.capacityKnown ? '' : '>= '}${last.uplink.uplinkMbps} Mbps` +
        (last.uplink.capacityKnown ? '' : ' (no capacity estimate on this path)'),
    );
  }
  if (last.budgetBps !== null) {
    lines.push(`budget      ${mbps(last.budgetBps)}${last.probing ? ' (probing)' : ''}`);
  }
  if (last.point) {
    lines.push(
      `asked       ${geometry(last.point.width, last.point.height, last.point.fps)} · ` +
        `${mbps(last.point.videoBps)} · ${last.point.bpp.toFixed(3)} bpp`,
    );
  }
  if (last.outbound) {
    lines.push(
      `sending     ${geometry(last.outbound.frameWidth, last.outbound.frameHeight, last.outbound.framesPerSecond)} · ` +
        `${mbps(last.outbound.targetBitrate)} · ${last.outbound.encoderImplementation ?? 'unknown encoder'} · ` +
        `limited by ${last.outbound.qualityLimitationReason ?? 'unknown'}`,
    );
  }
  lines.push(
    `health      ${last.senderHealth}` +
      (last.capacityPixelsPerSecond === null
        ? ''
        : ` · encode ceiling ${(last.capacityPixelsPerSecond / 1_000_000).toFixed(1)} Mpx/s`),
  );
  if (last.inbound) {
    lines.push(
      `receiving   ${geometry(last.inbound.frameWidth, last.inbound.frameHeight, last.inbound.framesPerSecond)} · ` +
        `${last.inbound.decoderImplementation ?? 'unknown decoder'} · ` +
        `${num(last.inbound.freezeCount)} freezes` +
        (last.inbound.totalFreezesDuration === null
          ? ''
          : ` (${last.inbound.totalFreezesDuration.toFixed(1)}s)`) +
        ` · buffer ${bufferMs(last.inbound)}`,
    );
  }
  if (last.level) {
    lines.push(`my verdict  ${last.level}${last.score === null ? '' : ` (${last.score})`}`);
  }
  if (last.viewerLevel || last.viewerViewport) {
    lines.push(
      `they say    ${last.viewerLevel ?? 'nothing'}` +
        (last.viewerViewport
          ? ` · drawing it at ${last.viewerViewport.width}x${last.viewerViewport.height}`
          : ' · no viewport reported'),
    );
  }
  if (last.peerShare) {
    const p = last.peerShare;
    lines.push(
      `their share ${geometry(p.width, p.height, p.fps)} · ${mbps(p.bps)} · ` +
        `${p.encoder ?? 'unknown encoder'} · limited by ${p.limitedBy ?? 'unknown'}`,
    );
  }
  return lines;
}

function logSection(logs: LogLine[]): string[] {
  if (logs.length === 0) return [];
  return [
    '',
    `— log (${logs.length} lines) —`,
    ...logs.map((l) => `${padStart(l.level, 5)} ${l.text}`),
  ];
}

/**
 * The whole thing, as one block of text a person can paste.
 *
 * Deliberately plain: no JSON, no markdown table syntax, nothing that renders
 * differently depending on where it lands. It is going into a chat window.
 */
export function formatDiagnosticsReport(report: DiagnosticsReport): string {
  const { header, samples, logs, ice } = report;
  const printed = samples.slice(-PRINTED_SAMPLES);
  const dropped = samples.length - printed.length;
  const endMs = samples.length > 0 ? samples[samples.length - 1].atMs : 0;

  const lines: string[] = [
    'WatchTogether debug report',
    `generated   ${header.generatedAt}`,
    `session     ${header.sessionId ?? '—'} · role ${header.role}`,
    `browser     ${header.userAgent}`,
    `display     dpr ${header.devicePixelRatio}` +
      (header.viewport ? ` · drawing at ${header.viewport.width}x${header.viewport.height}` : ''),
    `settings    quality ${header.quality} · content ${header.contentMode} · codec ${header.codec}`,
    ...nowSection(printed[printed.length - 1]),
    ...senderTable(printed, endMs),
    ...receiverTable(printed, endMs),
  ];

  if (samples.length === 0) {
    lines.push('', 'no samples recorded — the poll had not run yet');
  } else if (dropped > 0) {
    lines.push(
      '',
      `(${dropped} older sample${dropped === 1 ? '' : 's'} held but not printed)`,
    );
  }

  if (ice) lines.push('', '— ice —', ice);
  lines.push(...logSection(logs));

  return lines.join('\n');
}
